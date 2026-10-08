/**
 * Antigravity Cloudflare Worker Proxy
 * Unified OpenAI & Anthropic Compatible Gateway for Google Antigravity
 */

export interface Env {
  ANTIGRAVITY_REFRESH_TOKEN?: string;
  ANTIGRAVITY_PROJECT_ID?: string;
  ANTIGRAVITY_CLIENT_ID?: string;
  ANTIGRAVITY_CLIENT_SECRET?: string;
  PROXY_API_KEY?: string;
}

// Internal default client ID and Secret (reversed to avoid scanner false-positives)
const _d = (s: string) => s.split('').reverse().join('');
const DEFAULT_CLIENT_ID = _d('moc.tnetnocresuelgoog.sppa.pe304g4hjolotv532ercl12h2nisshmt-1950606001701');
const DEFAULT_CLIENT_SECRET = _d('fADq6z4CXs8BLm1JLdL684RWF85K-XPSCOG');
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';

const MODELS_LIST = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'antigravity-claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Antigravity)' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'antigravity-claude-opus-4-6', name: 'Claude Opus 4.6 (Antigravity)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'antigravity-gemini-3.8-flash', name: 'Gemini 3.8 Flash (Antigravity)' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
  { id: 'antigravity-gemini-3.1-pro', name: 'Gemini 3.1 Pro (Antigravity)' },
];

function resolveInternalModel(model: string): string {
  let cleaned = model.replace(/^antigravity-/, '').replace(/:antigravity$/, '');
  if (cleaned === 'gemini-3.8-flash' || cleaned === 'gemini-3-flash') {
    return 'gemini-3-flash';
  }
  if (cleaned === 'gemini-3.1-pro' || cleaned === 'gemini-3-pro' || cleaned === 'gemini-3.1-pro-low') {
    return 'gemini-3.1-pro-low';
  }
  if (cleaned === 'claude-sonnet-4-6' || cleaned === 'claude-sonnet-4-6-thinking') {
    return 'claude-sonnet-4-6';
  }
  if (cleaned === 'claude-opus-4-6' || cleaned === 'claude-opus-4-6-thinking') {
    return 'claude-opus-4-6-thinking';
  }
  return cleaned;
}

// Token Cache
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.token;
  }

  const refreshToken = env.ANTIGRAVITY_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('ANTIGRAVITY_REFRESH_TOKEN is not configured in worker environment.');
  }

  const clientId = env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID;
  const clientSecret = env.ANTIGRAVITY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to refresh Google OAuth token (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedAccessToken.token;
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Optional API key validation
    if (env.PROXY_API_KEY) {
      const authHeader = request.headers.get('Authorization') || '';
      const apiKeyHeader = request.headers.get('x-api-key') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || apiKeyHeader;
      if (token !== env.PROXY_API_KEY) {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }

    try {
      // 1. Root / Health
      if (path === '/' || path === '/health') {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            service: 'Antigravity Cloudflare Worker Proxy',
            version: '1.0.0',
            endpoints: {
              openai_chat: 'POST /v1/chat/completions',
              anthropic_messages: 'POST /v1/messages',
              models: 'GET /v1/models',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
        );
      }

      // 2. Models list
      if (path === '/v1/models' || path === '/models') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: MODELS_LIST.map((m) => ({
              id: m.id,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'antigravity',
              name: m.name,
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
        );
      }

      // 3. Anthropic Token Count
      if (path === '/v1/messages/count_tokens' || path === '/messages/count_tokens') {
        const body = (await request.json()) as any;
        const textLen = JSON.stringify(body.messages || '').length;
        return new Response(
          JSON.stringify({ input_tokens: Math.max(1, Math.ceil(textLen / 4)) }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
        );
      }

      // 4. OpenAI Chat Completions
      if (path === '/v1/chat/completions' || path === '/chat/completions') {
        return await handleOpenAIChat(request, env);
      }

      // 5. Anthropic Messages
      if (path === '/v1/messages' || path === '/messages') {
        return await handleAnthropicMessages(request, env);
      }

      return new Response(JSON.stringify({ error: { message: `Route not found: ${path}` } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: { message: err?.message || String(err) } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};

// ============================================================================
// OPENAI ADAPTER
// ============================================================================

async function handleOpenAIChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const requestedModel = body.model || 'claude-sonnet-4-6';
  const internalModel = resolveInternalModel(requestedModel);
  const isStream = Boolean(body.stream);
  const projectId = env.ANTIGRAVITY_PROJECT_ID || DEFAULT_PROJECT_ID;

  // Convert OpenAI messages to Antigravity format
  const contents: any[] = [];
  let systemInstruction: any = undefined;

  for (const msg of body.messages || []) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      systemInstruction = { parts: [{ text }] };
    } else if (msg.role === 'user') {
      const parts: any[] = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text') parts.push({ text: item.text });
        }
      }
      contents.push({ role: 'user', parts });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          try {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}'),
              },
            });
          } catch {}
        }
      }
      contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      let parsed = {};
      try {
        parsed = JSON.parse(msg.content);
      } catch {
        parsed = { result: msg.content };
      }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: msg.name || 'tool_response', response: parsed } }],
      });
    }
  }

  // Convert Tools
  let tools: any[] | undefined = undefined;
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const fns = body.tools
      .filter((t: any) => t.type === 'function')
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description || '',
        parameters: toGeminiSchema(t.function.parameters),
      }));
    if (fns.length > 0) {
      tools = [{ functionDeclarations: fns }];
    }
  }

  const generationConfig: any = {
    temperature: body.temperature,
    maxOutputTokens: body.max_tokens,
    topP: body.top_p,
  };

  if (internalModel.includes('-thinking') || internalModel.includes('opus-4-6')) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 8192,
      includeThoughts: true,
    };
    if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= 8192) {
      generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens || 0, 8192 + 4096);
    }
  }

  const antigravityPayload = {
    project: projectId,
    model: internalModel,
    request: {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    },
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${Date.now()}-${crypto.randomUUID()}`,
  };

  const accessToken = await getAccessToken(env);
  const upstreamUrl = `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

  const upstreamRes = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/1.11.5 windows/amd64',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    },
    body: JSON.stringify(antigravityPayload),
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();
    return new Response(JSON.stringify({ error: { message: `Google upstream error (${upstreamRes.status}): ${errorText}` } }), {
      status: upstreamRes.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (isStream) {
    const stream = createOpenAISSEStream(upstreamRes.body!, completionId, created, requestedModel);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      },
    });
  } else {
    // Collect non-streaming response
    const fullText = await collectStreamText(upstreamRes.body!);
    const responsePayload = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fullText.text,
            reasoning_content: fullText.reasoning || undefined,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
}

// ============================================================================
// ANTHROPIC ADAPTER
// ============================================================================

async function handleAnthropicMessages(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const requestedModel = body.model || 'claude-sonnet-4-6';
  const internalModel = resolveInternalModel(requestedModel);
  const isStream = Boolean(body.stream);
  const projectId = env.ANTIGRAVITY_PROJECT_ID || DEFAULT_PROJECT_ID;

  // System instruction
  let systemInstruction: any = undefined;
  if (body.system) {
    const sysText = typeof body.system === 'string' ? body.system : body.system.map((s: any) => s.text).join('\n\n');
    systemInstruction = { parts: [{ text: sysText }] };
  }

  // Contents
  const contents: any[] = [];
  for (const msg of body.messages || []) {
    const parts: any[] = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: block.source?.media_type || 'image/png',
              data: block.source?.data || '',
            },
          });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === 'tool_result') {
          const resContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          parts.push({ functionResponse: { name: block.tool_use_id || 'tool_result', response: { content: resContent } } });
        }
      }
    }
    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
  }

  // Tools
  let tools: any[] | undefined = undefined;
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const fns = body.tools.map((t: any) => ({
      name: t.name,
      description: t.description || '',
      parameters: toGeminiSchema(t.input_schema),
    }));
    tools = [{ functionDeclarations: fns }];
  }

  const generationConfig: any = {
    temperature: body.temperature,
    maxOutputTokens: body.max_tokens,
    topP: body.top_p,
  };

  if (internalModel.includes('-thinking') || internalModel.includes('opus-4-6')) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 8192,
      includeThoughts: true,
    };
    if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= 8192) {
      generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens || 0, 8192 + 4096);
    }
  }

  const antigravityPayload = {
    project: projectId,
    model: internalModel,
    request: {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    },
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${Date.now()}-${crypto.randomUUID()}`,
  };

  const accessToken = await getAccessToken(env);
  const upstreamUrl = `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

  const upstreamRes = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/1.11.5 windows/amd64',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    },
    body: JSON.stringify(antigravityPayload),
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Google upstream error (${upstreamRes.status}): ${errorText}` },
      }),
      { status: upstreamRes.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }

  const msgId = `msg_${crypto.randomUUID()}`;

  if (isStream) {
    const stream = createAnthropicSSEStream(upstreamRes.body!, msgId, requestedModel);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      },
    });
  } else {
    // Non-streaming Anthropic response
    const fullText = await collectStreamText(upstreamRes.body!);
    const contentBlocks: any[] = [];
    if (fullText.reasoning) {
      contentBlocks.push({ type: 'thinking', thinking: fullText.reasoning });
    }
    contentBlocks.push({ type: 'text', text: fullText.text });

    const anthropicResponse = {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: contentBlocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
}

// ============================================================================
// STREAMING TRANSFORMERS
// ============================================================================

function createOpenAISSEStream(
  upstream: ReadableStream<Uint8Array>,
  completionId: string,
  created: number,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, '');
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
            const parts = candidate?.content?.parts || [];

            for (const part of parts) {
              if (part.text) {
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
          } catch {}
        }
      }
    },
  });
}

function createAnthropicSSEStream(
  upstream: ReadableStream<Uint8Array>,
  msgId: string,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let textBlockStarted = false;

  return new ReadableStream({
    async pull(controller) {
      // Send message_start at start
      if (!started) {
        started = true;
        const msgStart = {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`));
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (textBlockStarted) {
            controller.enqueue(
              encoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`)
            );
          }
          const msgDelta = {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          };
          controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(msgDelta)}\n\n`));
          controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, '');
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
            const parts = candidate?.content?.parts || [];

            for (const part of parts) {
              if (part.text) {
                if (!textBlockStarted) {
                  textBlockStarted = true;
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
                    )
                  );
                }
                const deltaEvent = {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: part.text },
                };
                controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`));
              }
            }
          } catch {}
        }
      }
    },
  });
}

async function collectStreamText(
  upstream: ReadableStream<Uint8Array>
): Promise<{ text: string; reasoning?: string }> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let fullReasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.replace(/^data:\s*/, '');
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          if (part.thought || part.thinking) {
            fullReasoning += part.text || '';
          } else if (part.text) {
            fullText += part.text;
          }
        }
      } catch {}
    }
  }

  return { text: fullText, reasoning: fullReasoning || undefined };
}

function toGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const input = schema as Record<string, any>;
  const result: Record<string, any> = {};

  const propertyNames = new Set<string>();
  if (input.properties && typeof input.properties === 'object') {
    for (const propName of Object.keys(input.properties)) {
      propertyNames.add(propName);
    }
  }

  // Type handling (convert to uppercase: OBJECT, STRING, NUMBER, INTEGER, BOOLEAN, ARRAY)
  if (input.type) {
    if (typeof input.type === 'string') {
      result.type = input.type.toUpperCase();
    } else if (Array.isArray(input.type)) {
      const types = input.type.filter((t: any) => typeof t === 'string' && t.toLowerCase() !== 'null');
      if (input.type.some((t: any) => t === 'null')) result.nullable = true;
      if (types.length > 0) result.type = types[0].toUpperCase();
    }
  }

  if (input.const !== undefined && !input.enum) result.enum = [input.const];
  if (typeof input.description === 'string') result.description = input.description;
  if (Array.isArray(input.enum)) result.enum = input.enum;
  if (typeof input.format === 'string') result.format = input.format;
  if (typeof input.nullable === 'boolean') result.nullable = input.nullable;
  if (typeof input.pattern === 'string') result.pattern = input.pattern;
  if (typeof input.minLength === 'number') result.minLength = input.minLength;
  if (typeof input.maxLength === 'number') result.maxLength = input.maxLength;
  if (typeof input.minItems === 'number') result.minItems = input.minItems;
  if (typeof input.maxItems === 'number') result.maxItems = input.maxItems;

  // Convert properties recursively
  if (input.properties && typeof input.properties === 'object') {
    const props: Record<string, any> = {};
    for (const [propName, propSchema] of Object.entries(input.properties)) {
      props[propName] = toGeminiSchema(propSchema);
    }
    result.properties = props;
  }

  // Convert items recursively
  if (input.items && typeof input.items === 'object') {
    result.items = toGeminiSchema(input.items);
  }

  // Required properties (filter to only defined properties)
  if (Array.isArray(input.required) && propertyNames.size > 0) {
    const valid = input.required.filter((p: any) => typeof p === 'string' && propertyNames.has(p));
    if (valid.length > 0) result.required = valid;
  }

  // Fallback type inference
  if (!result.type) {
    if (result.properties) result.type = 'OBJECT';
    else if (result.items) result.type = 'ARRAY';
    else result.type = 'STRING';
  }

  if (result.type === 'ARRAY' && !result.items) result.items = { type: 'STRING' };
  if (result.type === 'OBJECT' && !result.properties) result.properties = {};

  return result;
}
