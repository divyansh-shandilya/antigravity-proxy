/**
 * Anthropic Messages Route - Anthropic-compatible API endpoint
 * POST /v1/messages and POST /messages
 * POST /v1/messages/count_tokens and POST /messages/count_tokens
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { anthropicAdapter, type AnthropicRequest } from '../adapters/anthropic-adapter.js';
import { accountService } from '../services/account-manager.js';
import { accessTokenExpired } from '../lib/auth/auth.js';
import { refreshAccessToken } from '../lib/auth/token.js';
import { createLogger } from '../lib/logger.js';
import { metricsService } from '../services/metrics-collector.js';
import { logService } from '../services/log-store.js';
import { upstreamQueue } from '../services/request-queue.js';

const log = createLogger('anthropic-messages-route');

interface MessagesRequest extends FastifyRequest {
  body: AnthropicRequest;
}

export default async function messagesRoutes(server: FastifyInstance) {
  // Token count endpoint
  const handleCountTokens = async (request: MessagesRequest, reply: FastifyReply) => {
    const req = request.body || {};
    let totalChars = 0;
    if (typeof req.system === 'string') totalChars += req.system.length;
    if (Array.isArray(req.messages)) {
      for (const m of req.messages) {
        if (typeof m.content === 'string') {
          totalChars += m.content.length;
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'text' && b.text) totalChars += b.text.length;
          }
        }
      }
    }
    const estimatedTokens = Math.max(1, Math.round(totalChars / 4));
    return reply.send({ input_tokens: estimatedTokens });
  };

  server.post<{ Body: AnthropicRequest }>('/messages/count_tokens', handleCountTokens);

  // Main messages endpoint
  const handleMessages = async (request: MessagesRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    const anthropicReq = request.body;

    log.info('⬇️ INCOMING ANTHROPIC REQUEST', {
      headers: request.headers,
      model: anthropicReq?.model,
      stream: anthropicReq?.stream,
    });

    try {
      if (!anthropicReq.model) {
        return reply.status(400).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Missing required field: model',
          },
        });
      }

      if (!anthropicReq.messages || !Array.isArray(anthropicReq.messages) || anthropicReq.messages.length === 0) {
        return reply.status(400).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Missing required field: messages',
          },
        });
      }

      const internalModel = anthropicAdapter.resolveAntigravityModel(anthropicReq.model);

      log.info('Anthropic message request resolved', {
        requestedModel: anthropicReq.model,
        internalModel,
        messageCount: anthropicReq.messages.length,
        stream: anthropicReq.stream,
        hasTools: Boolean(anthropicReq.tools && anthropicReq.tools.length > 0),
      });

      // Get account from rotation
      const account = await accountService.getNextAccount(internalModel);

      if (!account) {
        return reply.status(429).send({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'All accounts are rate-limited. Please try again later.',
          },
        });
      }

      // Get auth details from account
      const manager = await accountService.getAccountManager();
      let auth = await manager.toAuthDetails(account);

      // Refresh token if needed
      if (accessTokenExpired(auth)) {
        log.debug('Access token expired, refreshing...', {
          accountIndex: account.index,
          email: account.email,
        });

        const refreshed = await refreshAccessToken(auth);
        if (!refreshed) {
          log.error('Token refresh failed', {
            accountIndex: account.index,
          });

          return reply.status(500).send({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'Authentication failed. Please re-authenticate.',
            },
          });
        }

        manager.updateFromAuth(account, refreshed);
        await manager.saveToDisk();
        auth = refreshed;
      }

      const accessToken = auth.access;
      if (!accessToken) {
        return reply.status(500).send({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Missing access token',
          },
        });
      }

      const projectId = account.parts.projectId || account.parts.managedProjectId || 'rising-fact-p41fc';

      // Convert Anthropic request to Antigravity format
      const { url, init, headerStyle } = await anthropicAdapter.convertRequest(
        anthropicReq,
        accessToken,
        projectId
      );

      try {
        fs.writeFileSync('debug-anthropic-req.json', JSON.stringify(anthropicReq, null, 2));
        fs.writeFileSync('debug-antigravity-body.json', String(init.body));
      } catch {}

      log.info('Making Antigravity request for Anthropic client', {
        url,
        projectId,
        headerStyle,
        accountIndex: account.index,
      });

      const response = await upstreamQueue.execute(
        () => fetch(url, init),
        { model: anthropicReq.model, maxRetries: 4 }
      );

      // Handle rate limits after retries
      if (response.status === 429) {
        const errorText = await response.text().catch(() => '');
        log.warn('Rate limited on Antigravity upstream after queue retries', {
          accountIndex: account.index,
          model: anthropicReq.model,
          error: errorText.slice(0, 1000),
        });

        await accountService.markRateLimited(account, 5000, internalModel);
        metricsService.recordRequest(anthropicReq.model, Date.now() - startTime, 'rate_limited');

        reply.header('retry-after', '3');
        return reply.status(429).send({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Upstream rate limit exceeded. Please retry in a few seconds.',
          },
        });
      }

      // Handle other errors
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        log.error('❌ ANTIGRAVITY API ERROR FOR ANTHROPIC', {
          status: response.status,
          statusText: response.statusText,
          body: errorText.slice(0, 2000),
          url,
        });

        metricsService.recordRequest(anthropicReq.model, Date.now() - startTime, 'error');

        let clientMessage = `Antigravity API error: ${response.statusText}. Check server logs for details.`;
        try {
          const parsedErr = JSON.parse(errorText);
          if (parsedErr.error?.message) {
            clientMessage = `Antigravity API error: ${parsedErr.error.message}`;
          }
        } catch {}

        return reply.status(response.status).send({
          type: 'error',
          error: {
            type: 'api_error',
            message: clientMessage,
          },
        });
      }

      // Handle streaming response
      if (anthropicReq.stream) {
        reply.hijack();
        const raw = reply.raw;

        raw.socket?.setNoDelay(true);

        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        raw.flushHeaders?.();

        let streamBuffer = '';

        for await (const chunk of anthropicAdapter.convertStream(response.body!, anthropicReq.model)) {
          streamBuffer += chunk;
          raw.write(chunk);
          if ((raw as any).flush) {
            (raw as any).flush();
          }
        }

        raw.end();

        const duration = Date.now() - startTime;
        metricsService.recordRequest(anthropicReq.model, duration, 'success');
        logService.logRequest(
          anthropicReq.model,
          'stream',
          duration,
          'success',
          undefined,
          anthropicReq as any,
          streamBuffer
        );

        return;
      }

      // Handle non-streaming response
      const anthropicResponse = await anthropicAdapter.convertResponse(response, anthropicReq.model);

      const duration = Date.now() - startTime;
      metricsService.recordRequest(anthropicReq.model, duration, 'success');
      logService.logRequest(
        anthropicReq.model,
        'completion',
        duration,
        'success',
        anthropicResponse.usage?.output_tokens,
        anthropicReq as any,
        JSON.stringify(anthropicResponse)
      );

      return reply.send(anthropicResponse);
    } catch (error) {
      log.error('Anthropic request processing failed', {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      metricsService.recordRequest(anthropicReq?.model || 'unknown', Date.now() - startTime, 'error');

      return reply.status(500).send({
        type: 'error',
        error: {
          type: 'internal_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
    }
  };

  server.post<{ Body: AnthropicRequest }>('/messages', handleMessages);
}
