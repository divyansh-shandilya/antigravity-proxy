/**
 * OpenAI-compatible API adapter for Antigravity
 * Converts between OpenAI format (used by Zed) and Antigravity format
 */

import { createLogger } from '../lib/logger.js';
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  GEMINI_CLI_ENDPOINT,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  type HeaderStyle,
} from '../lib/constants.js';

const log = createLogger('openai-adapter');

// OpenAI API types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Antigravity API types (simplified)
interface AntigravityContent {
  role: 'user' | 'model';
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
  }>;
}

interface AntigravityTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface AntigravityRequest {
  contents: AntigravityContent[];
  tools?: AntigravityTool[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

export class OpenAIToAntigravityAdapter {
  /**
   * Allowed fields in Gemini / CloudCode Schema protobuf
   */
  private readonly ALLOWED_SCHEMA_FIELDS = new Set([
    'type',
    'format',
    'title',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'pattern',
    'minimum',
    'maximum',
    'minProperties',
    'maxProperties',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'default',
    'example',
  ]);

  /**
   * Converts JSON Schema to Gemini-compatible format
   */
  private toGeminiSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return schema;
    }

    const inputSchema = schema as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    const propertyNames = new Set<string>();
    if (inputSchema.properties && typeof inputSchema.properties === 'object') {
      for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) {
        propertyNames.add(propName);
      }
    }

    // Handle type (support string or array of types like ['string', 'null'])
    if (inputSchema.type) {
      if (typeof inputSchema.type === 'string') {
        result.type = inputSchema.type.toUpperCase();
      } else if (Array.isArray(inputSchema.type)) {
        const types = (inputSchema.type as unknown[]).filter(
          (t): t is string => typeof t === 'string' && t.toLowerCase() !== 'null'
        );
        const hasNull = (inputSchema.type as unknown[]).some((t) => t === 'null');
        if (hasNull) result.nullable = true;
        if (types.length > 0) result.type = types[0].toUpperCase();
      }
    }

    // Handle const -> enum
    if (inputSchema.const !== undefined && !inputSchema.enum) {
      result.enum = [inputSchema.const];
    }

    // Handle examples -> example
    if (
      result.example === undefined &&
      Array.isArray(inputSchema.examples) &&
      inputSchema.examples.length > 0
    ) {
      result.example = inputSchema.examples[0];
    }

    // Fallback for exclusiveMinimum / exclusiveMaximum to standard minimum / maximum
    if (inputSchema.exclusiveMinimum !== undefined && inputSchema.minimum === undefined) {
      result.minimum = inputSchema.exclusiveMinimum;
    }
    if (inputSchema.exclusiveMaximum !== undefined && inputSchema.maximum === undefined) {
      result.maximum = inputSchema.exclusiveMaximum;
    }

    // Process only allowed fields to prevent Protobuf JSON deserialization errors
    for (const [key, value] of Object.entries(inputSchema)) {
      if (!this.ALLOWED_SCHEMA_FIELDS.has(key)) {
        continue;
      }

      if (key === 'type') {
        // Handled above
        continue;
      } else if (key === 'properties' && typeof value === 'object' && value !== null) {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[propName] = this.toGeminiSchema(propSchema);
        }
        result[key] = props;
      } else if (key === 'items' && typeof value === 'object' && value !== null) {
        result[key] = this.toGeminiSchema(value);
      } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
        result[key] = value.map((item) => this.toGeminiSchema(item));
      } else if (key === 'required' && Array.isArray(value)) {
        if (propertyNames.size > 0) {
          const validRequired = value.filter(
            (prop) => typeof prop === 'string' && propertyNames.has(prop)
          );
          if (validRequired.length > 0) {
            result[key] = validRequired;
          }
        }
      } else {
        result[key] = value;
      }
    }

    // Infer missing type if possible
    if (!result.type) {
      if (result.properties) {
        result.type = 'OBJECT';
      } else if (result.items) {
        result.type = 'ARRAY';
      } else if (result.anyOf && Array.isArray(result.anyOf)) {
        const types = new Set<string>();
        for (const option of result.anyOf as Array<{ type?: string }>) {
          if (option && option.type) {
            types.add(option.type);
          }
        }
        if (types.size === 1) {
          result.type = Array.from(types)[0];
        }
      }
    }

    if (result.type === 'ARRAY' && !result.items) {
      result.items = { type: 'STRING' };
    }
    if (result.type === 'OBJECT' && !result.properties) {
      result.properties = {};
    }

    return result;
  }

  /**
   * Determines appropriate header style based on model name
   */
  getHeaderStyle(model: string): HeaderStyle {
    const lower = model.toLowerCase();

    // Models with antigravity- prefix use Antigravity headers
    if (lower.startsWith('antigravity-')) {
      return 'antigravity';
    }

    // Claude and Gemini 3.x models always use Antigravity
    if (lower.includes('claude') || lower.includes('gemini-3')) {
      return 'antigravity';
    }

    // Gemini models default to gemini-cli (production endpoint)
    return 'gemini-cli';
  }

  /**
   * Extracts the actual model name (strips prefix/suffix)
   */
  extractModelName(model: string): string {
    // Remove "antigravity-" prefix if present
    let cleaned = model.replace(/^antigravity-/, '');

    // Remove ":antigravity" suffix if present
    cleaned = cleaned.replace(/:antigravity$/, '');

    return cleaned;
  }

  /**
   * Converts OpenAI messages to Antigravity contents
   */
  convertMessages(messages: OpenAIMessage[]): {
    contents: AntigravityContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    const contents: AntigravityContent[] = [];
    let systemText = '';

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Collect system messages
        const text = typeof msg.content === 'string' ? msg.content : '';
        systemText += (systemText ? '\n\n' : '') + text;
        continue;
      }

      if (msg.role === 'user') {
        const parts: AntigravityContent['parts'] = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              parts.push({ text: part.text });
            }
            // TODO: Handle image_url if needed
          }
        }

        contents.push({ role: 'user', parts });
      } else if (msg.role === 'assistant') {
        const parts: AntigravityContent['parts'] = [];

        if (msg.content) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text) parts.push({ text });
        }

        if (msg.tool_calls) {
          for (const toolCall of msg.tool_calls) {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              parts.push({
                functionCall: {
                  name: toolCall.function.name,
                  args,
                },
              });
            } catch (e) {
              log.warn('Failed to parse tool call arguments', {
                toolCall: toolCall.function.name,
                error: String(e),
              });
            }
          }
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool results
        try {
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          const response = contentStr ? JSON.parse(contentStr) : {};
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: msg.name || 'unknown',
                response,
              },
            }],
          });
        } catch {
          // Fallback: treat as text
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          contents.push({
            role: 'user',
            parts: [{ text: contentStr || '' }],
          });
        }
      }
    }

    // Prepend Antigravity system instruction if using Antigravity models
    const fullSystemText = ANTIGRAVITY_SYSTEM_INSTRUCTION + (systemText ? '\n\n' + systemText : '');

    return {
      contents,
      systemInstruction: fullSystemText ? { parts: [{ text: fullSystemText }] } : undefined,
    };
  }

  /**
   * Wraps tools array in Gemini's required functionDeclarations format
   */
  private wrapToolsAsFunctionDeclarations(tools: OpenAITool[]): AntigravityTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }> = [];

    for (const tool of tools) {
      if (tool.type !== 'function') continue;

      const name = String(tool.function.name || `tool-${functionDeclarations.length}`);
      const description = String(tool.function.description || '');
      const schema = tool.function.parameters || { type: 'OBJECT', properties: {} };

      functionDeclarations.push({
        name,
        description,
        parameters: this.toGeminiSchema(schema) as Record<string, unknown>,
      });
    }

    return functionDeclarations.length > 0
      ? [{ functionDeclarations }]
      : undefined;
  }

  /**
   * Converts OpenAI tools to Antigravity functionDeclarations
   */
  convertTools(tools?: OpenAITool[]): AntigravityTool[] | undefined {
    return this.wrapToolsAsFunctionDeclarations(tools || []);
  }

  /**
   * Resolves internal Antigravity model ID from public model name
   */
  resolveAntigravityModel(model: string): string {
    const name = this.extractModelName(model);

    // Gemini 3.1 Pro models (Google retired 3.0 Pro, forwarding to 3.1 Pro)
    if (name === 'gemini-3.1-pro' || name === 'gemini-3-pro' || name === 'gemini-3.1-pro-low') {
      return 'gemini-3.1-pro-low';
    }

    // Gemini Flash models (Gemini 3.8 Flash / 3 Flash)
    if (name === 'gemini-3.8-flash' || name === 'gemini-3-flash') {
      return 'gemini-3-flash';
    }

    // Claude 4.6 models
    if (name === 'claude-sonnet-4-6' || name === 'claude-sonnet-4-6-thinking') {
      return 'claude-sonnet-4-6';
    }

    if (name === 'claude-opus-4-6' || name === 'claude-opus-4-6-thinking') {
      return 'claude-opus-4-6-thinking';
    }

    // For Claude models, use names directly as documented in Antigravity API spec
    const directModels = [
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-thinking',
      'claude-opus-4-5-thinking',
    ];

    if (directModels.includes(name)) {
      return name;
    }

    // Map of public names to internal Antigravity IDs (for legacy compatibility)
    const mappings: Record<string, string> = {
      // Gemini models
      'gemini-2.0-flash-thinking-exp': 'gemini-2.0-flash-thinking-exp-1219',
      
      // Claude aliases
      'sonnet': 'claude-sonnet-4-6',
      'claude-3-5-sonnet': 'claude-sonnet-4-6',
      'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
      'claude-sonnet': 'claude-sonnet-4-6',
      'opus': 'claude-opus-4-6-thinking',
      'claude-3-opus': 'claude-opus-4-6-thinking',
      'claude-opus': 'claude-opus-4-6-thinking',
    };

    return mappings[name] || name;
  }

  /**
   * Builds the full Antigravity API URL
   */
  buildAntigravityUrl(
    headerStyle: HeaderStyle,
    stream: boolean
  ): string {
    const baseEndpoint = headerStyle === 'gemini-cli' ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const query = stream ? '?alt=sse' : '';

    return `${baseEndpoint}/v1internal:${method}${query}`;
  }

  /**
   * Checks if a model is a thinking model
   */
  isThinkingModel(model: string): boolean {
    return model.includes('-thinking') || model.includes('opus-4-6');
  }

  /**
   * Gets the thinking budget for a thinking model
   * Based on THINKING_TIER_BUDGETS from opencode-antigravity-auth
   */
  getThinkingBudget(model: string): number {
    const budgets: Record<string, number> = {
      'claude-sonnet-4-5-thinking': 8192,
      'claude-opus-4-5-thinking': 8192,
      'claude-sonnet-4-6-thinking': 8192,
      'claude-opus-4-6-thinking': 8192,
    };
    return budgets[model] || 8192;
  }

  /**
   * Converts full OpenAI request to Antigravity format
   */
  async convertRequest(
    openaiReq: OpenAIRequest,
    accessToken: string,
    projectId: string
  ): Promise<{
    url: string;
    init: RequestInit;
    headerStyle: HeaderStyle;
  }> {
    const headerStyle = this.getHeaderStyle(openaiReq.model);
    const modelName = this.extractModelName(openaiReq.model);
    const stream = openaiReq.stream ?? false;

    // Resolve the actual internal model ID
    const internalModel = this.resolveAntigravityModel(modelName);

    const { contents, systemInstruction } = this.convertMessages(openaiReq.messages);
    const tools = this.convertTools(openaiReq.tools);

    const generationConfig: any = {
      temperature: openaiReq.temperature,
      maxOutputTokens: openaiReq.max_tokens,
      topP: openaiReq.top_p,
      stopSequences: openaiReq.stop
        ? Array.isArray(openaiReq.stop) ? openaiReq.stop : [openaiReq.stop]
        : undefined,
    };

    if (this.isThinkingModel(internalModel)) {
      const budget = this.getThinkingBudget(internalModel);
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      };
      if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= budget) {
        generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens || 0, budget + 4096);
      }
    }

    const requestPayload: AntigravityRequest = {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    };

    // Wrap the body as required by v1internal endpoint
    const wrappedBody = {
      project: projectId,
      model: internalModel,
      request: requestPayload,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const url = this.buildAntigravityUrl(headerStyle, stream);
    const headers = headerStyle === 'gemini-cli' ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;

    return {
      url,
      headerStyle,
      init: {
        method: 'POST',
        headers: {
          ...headers,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(wrappedBody),
      },
    };
  }

  /**
   * Converts Antigravity response to OpenAI format
   */
  async convertResponse(antigravityRes: Response, requestedModel: string): Promise<OpenAIResponse> {
    const data: any = await antigravityRes.json();

    // Extract content from Antigravity response
    const candidates = data.response?.candidates || data.candidates || [];
    const firstCandidate = candidates[0];

    let content: string | null = null;
    let reasoningContent: string | null = null;
    const toolCalls: OpenAIResponse['choices'][0]['message']['tool_calls'] = [];

    if (firstCandidate?.content?.parts) {
      for (const part of firstCandidate.content.parts) {
        if (part.thought === true) {
          if (part.text) {
            reasoningContent = (reasoningContent || '') + part.text;
          }
        } else if (typeof part.thought === 'string' && part.thought) {
          reasoningContent = (reasoningContent || '') + part.thought;
        } else if (typeof part.thinking === 'string' && part.thinking) {
          reasoningContent = (reasoningContent || '') + part.thinking;
        } else if (part.text) {
          content = (content || '') + part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
        }
      }
    }

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoningContent && { reasoning_content: reasoningContent }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      }],
      usage: data.response?.usageMetadata || data.usageMetadata ? {
        prompt_tokens: data.response?.usageMetadata?.promptTokenCount || data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.response?.usageMetadata?.candidatesTokenCount || data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.response?.usageMetadata?.totalTokenCount || data.usageMetadata?.totalTokenCount || 0,
      } : undefined,
    };
  }

  /**
   * Converts Antigravity SSE stream to OpenAI format
   */
  async *convertStream(
    stream: ReadableStream,
    requestedModel: string
  ): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasSentRole = false;
    let hasToolCalls = false;
    const streamId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let lastUsageMetadata: any = null;

    log.info('Starting stream conversion', { requestedModel });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.info('Stream reading completed');
          // If usage metadata was collected, emit final usage chunk
          if (lastUsageMetadata) {
            const usageChunk = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [],
              usage: {
                prompt_tokens: lastUsageMetadata.promptTokenCount || 0,
                completion_tokens: lastUsageMetadata.candidatesTokenCount || 0,
                total_tokens: lastUsageMetadata.totalTokenCount || 0,
              },
            };
            yield `data: ${JSON.stringify(usageChunk)}\n\n`;
          }
          yield 'data: [DONE]\n\n';
          break;
        }

        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (!trimmed.startsWith('data:')) {
            log.debug('Skipping non-data line', { line: trimmed.slice(0, 100) });
            continue;
          }

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            yield 'data: [DONE]\n\n';
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const usage = parsed.response?.usageMetadata || parsed.usageMetadata;
            if (usage) {
              lastUsageMetadata = usage;
            }

            const openaiChunk = this.convertStreamChunk(
              parsed,
              requestedModel,
              streamId,
              created,
              !hasSentRole,
              hasToolCalls
            );

            if (openaiChunk) {
              if (!hasSentRole && openaiChunk.choices?.[0]?.delta?.role) {
                hasSentRole = true;
              }
              if (openaiChunk.choices?.[0]?.delta?.tool_calls) {
                hasToolCalls = true;
              }
              yield `data: ${JSON.stringify(openaiChunk)}\n\n`;
            }
          } catch (e) {
            log.warn('Failed to parse stream chunk', { error: String(e), data: data.slice(0, 200) });
          }
        }
      }
    } catch (error) {
      log.error('Stream reading error', { error: String(error) });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Converts a single Antigravity stream chunk to OpenAI format
   */
  private convertStreamChunk(
    antigravityChunk: any,
    requestedModel: string,
    streamId: string,
    created: number,
    includeRole: boolean,
    priorToolCalls: boolean
  ) {
    const candidates = antigravityChunk.response?.candidates || antigravityChunk.candidates || [];
    const firstCandidate = candidates[0];

    const delta: any = {};
    if (includeRole) {
      delta.role = 'assistant';
    }

    let hasContent = false;
    let hasTools = false;

    if (firstCandidate?.content?.parts) {
      for (const part of firstCandidate.content.parts) {
        if (part.thought === true) {
          if (part.text) {
            delta.reasoning_content = (delta.reasoning_content || '') + part.text;
            hasContent = true;
          }
        } else if (typeof part.thought === 'string' && part.thought) {
          delta.reasoning_content = (delta.reasoning_content || '') + part.thought;
          hasContent = true;
        } else if (typeof part.thinking === 'string' && part.thinking) {
          delta.reasoning_content = (delta.reasoning_content || '') + part.thinking;
          hasContent = true;
        } else if (part.text) {
          delta.content = (delta.content || '') + part.text;
          hasContent = true;
        }
        if (part.functionCall) {
          if (!delta.tool_calls) delta.tool_calls = [];
          delta.tool_calls.push({
            index: delta.tool_calls.length,
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
          hasTools = true;
        }
      }
    }

    // Determine finish_reason
    let finishReason: 'stop' | 'length' | 'tool_calls' | null = null;
    const rawFinishReason = firstCandidate?.finishReason;
    if (rawFinishReason) {
      if (rawFinishReason === 'MAX_TOKENS') {
        finishReason = 'length';
      } else if (hasTools || priorToolCalls) {
        finishReason = 'tool_calls';
      } else {
        finishReason = 'stop';
      }
    }

    // Don't emit completely empty chunk unless finishReason is present
    if (!hasContent && !hasTools && !includeRole && finishReason === null) {
      return null;
    }

    return {
      id: streamId,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
  }
}

export const adapter = new OpenAIToAntigravityAdapter();
