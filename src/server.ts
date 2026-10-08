/**
 * Antigravity Proxy Server
 * OpenAI-compatible API gateway for Google Antigravity
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { createLogger, setLogLevel } from './lib/logger.js';
import { accountService } from './services/account-manager.js';

import chatRoutes from './routes/chat.js';
import messagesRoutes from './routes/messages.js';
import modelsRoutes from './routes/models.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('server');

// Set log level from environment
if (process.env.LOG_LEVEL) {
  setLogLevel(process.env.LOG_LEVEL as any);
}

async function main() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  // Create Fastify instance
  const server = Fastify({
    logger: false, // Use our custom logger
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  // Register CORS
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Register static files for admin dashboard
  if (process.env.ADMIN_ENABLED !== 'false') {
    await server.register(fastifyStatic, {
      root: join(__dirname, 'dashboard'),
      prefix: '/admin/static/',
    });
  }

  // Initialize account service
  try {
    await accountService.initialize();
    const accountCount = await accountService.getAccountCount();
    
    if (accountCount === 0) {
      log.warn('⚠️  No accounts configured!');
      log.warn('Run authentication: npm run auth');
    } else {
      log.info(`✓ Loaded ${accountCount} account(s)`);
    }
  } catch (error) {
    log.error('Failed to initialize accounts', { error: String(error) });
    log.warn('Server will start but /chat/completions will fail until authentication is configured');
  }

  // Register routes
  log.info('Registering routes...');
  
  // Register OpenAI routes
  await server.register(chatRoutes, { prefix: '/v1' });
  await server.register(chatRoutes);
  log.info('✓ POST /v1/chat/completions & /chat/completions (OpenAI format)');

  // Register Anthropic routes
  await server.register(messagesRoutes, { prefix: '/v1' });
  await server.register(messagesRoutes);
  log.info('✓ POST /v1/messages & /messages (Anthropic format)');

  // Register Models routes
  await server.register(modelsRoutes, { prefix: '/v1' });
  await server.register(modelsRoutes);
  log.info('✓ GET /v1/models & /models');

  await server.register(healthRoutes);
  log.info('✓ GET /health');

  if (process.env.ADMIN_ENABLED !== 'false') {
    await server.register(adminRoutes, { prefix: '/admin' });
    log.info('✓ GET /admin (dashboard)');
  }

  // Root endpoint
  server.get('/', async () => {
    return {
      name: 'Antigravity Unified Proxy (OpenAI + Anthropic)',
      version: '1.1.0',
      description: 'OpenAI and Anthropic compatible API gateway for Google Antigravity',
      endpoints: {
        openai_chat: 'POST /v1/chat/completions or POST /chat/completions',
        anthropic_messages: 'POST /v1/messages or POST /messages',
        models: 'GET /v1/models or GET /models',
        health: 'GET /health',
        admin: 'GET /admin',
      },
      documentation: 'https://github.com/NoeFabris/antigravity-proxy',
    };
  });

  // Error handler
  server.setErrorHandler((error, request, reply) => {
    log.error('Request error', {
      url: request.url,
      method: request.method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Format error according to request path (Anthropic format if /messages)
    const isAnthropic = request.url.includes('/messages');
    if (isAnthropic) {
      reply.status(500).send({
        type: 'error',
        error: {
          type: 'internal_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
      return;
    }

    reply.status(500).send({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'internal_error',
      },
    });
  });

  // Start server
  try {
    await server.listen({ port, host });

    console.log('');
    console.log('🚀 Antigravity Proxy (OpenAI + Anthropic)');
    console.log('━'.repeat(55));
    console.log(`   Local:    http://localhost:${port}`);
    console.log(`   Network:  http://${host}:${port}`);
    console.log('━'.repeat(55));
    console.log('');
    console.log('API Endpoints:');
    console.log(`   • OpenAI:    POST http://localhost:${port}/v1/chat/completions`);
    console.log(`   • Anthropic: POST http://localhost:${port}/v1/messages`);
    console.log(`                POST http://localhost:${port}/messages`);
    console.log(`   • Models:    GET  http://localhost:${port}/v1/models`);
    console.log(`   • Health:    GET  http://localhost:${port}/health`);

    if (process.env.ADMIN_ENABLED !== 'false') {
      console.log(`   • Admin:     GET  http://localhost:${port}/admin`);
    }

    console.log('');
    console.log('Ready to accept OpenAI and Anthropic requests!');
    console.log('');

  } catch (error) {
    log.error('Failed to start server', {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down gracefully...`);
    
    try {
      await server.close();
      log.info('Server closed');
      process.exit(0);
    } catch (error) {
      log.error('Error during shutdown', { error: String(error) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
