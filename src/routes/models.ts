/**
 * Models route - Lists available models
 * GET /v1/models and GET /models
 */

import type { FastifyInstance } from 'fastify';

const AVAILABLE_MODELS = [
  // Antigravity models (prefixed)
  {
    id: 'antigravity-claude-sonnet-4-6',
    object: 'model',
    type: 'model',
    display_name: 'Claude Sonnet 4.6 (Antigravity)',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-opus-4-6',
    object: 'model',
    type: 'model',
    display_name: 'Claude Opus 4.6 Thinking (Antigravity)',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.1-pro',
    object: 'model',
    type: 'model',
    display_name: 'Gemini 3.1 Pro (Antigravity)',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.8-flash',
    object: 'model',
    type: 'model',
    display_name: 'Gemini 3.8 Flash (Antigravity)',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  // Anthropic Claude models
  {
    id: 'claude-sonnet-4-6',
    object: 'model',
    type: 'model',
    display_name: 'Claude Sonnet 4.6',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  {
    id: 'claude-opus-4-6',
    object: 'model',
    type: 'model',
    display_name: 'Claude Opus 4.6',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },

  // Gemini models
  {
    id: 'gemini-3.1-pro',
    object: 'model',
    type: 'model',
    display_name: 'Gemini 3.1 Pro',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
  {
    id: 'gemini-3.8-flash',
    object: 'model',
    type: 'model',
    display_name: 'Gemini 3.8 Flash',
    created: 1740000000,
    created_at: '2025-02-19T00:00:00Z',
    owned_by: 'google-antigravity',
  },
];

export default async function modelsRoutes(server: FastifyInstance) {
  server.get('/models', async () => {
    return {
      object: 'list',
      data: AVAILABLE_MODELS,
      has_more: false,
    };
  });

  server.get('/models/:model', async (request: any, reply) => {
    const modelId = request.params.model;
    const model = AVAILABLE_MODELS.find(
      (m) => m.id === modelId || m.id === `antigravity-${modelId}` || m.id.replace(/^antigravity-/, '') === modelId
    );

    if (!model) {
      return reply.status(404).send({
        error: {
          message: `Model '${modelId}' not found`,
          type: 'invalid_request_error',
        },
      });
    }

    return model;
  });
}
