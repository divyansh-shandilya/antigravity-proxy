/**
 * Anthropic Adapter - Bridges Anthropic Messages API to Google Antigravity
 * Supports:
 * - Text, images (base64 inlineData)
 * - Thinking/reasoning (Anthropic thinking blocks & delta events)
 * - Tool use & tool results
 * - Streaming with official Anthropic SSE events
 */

import {
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  type HeaderStyle,
} from '../lib/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('anthropic-adapter');

export interface AnthropicContentBlockText {
  type: 'text';
  text: string;
}

export interface AnthropicContentBlockImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

export interface AnthropicContentBlockThinking {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockImage
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult
  | AnthropicContentBlockThinking;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  thinking?: {
    type: 'enabled';
    budget_tokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Antigravity internal types
interface AntigravityPart {
  text?: string;
  thought?: boolean | string;
  thinking?: boolean | string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface AntigravityContent {
  role: 'user' | 'model';
  parts: AntigravityPart[];
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
    thinkingConfig?: {
      thinkingBudget: number;
      includeThoughts: boolean;
    };
  };
}

export class AnthropicToAntigravityAdapter {
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

    if (inputSchema.const !== undefined && !inputSchema.enum) {
      result.enum = [inputSchema.const];
    }

    if (
      result.example === undefined &&
      Array.isArray(inputSchema.examples) &&
      inputSchema.examples.length > 0
    ) {
      result.example = inputSchema.examples[0];
    }

    if (inputSchema.exclusiveMinimum !== undefined && inputSchema.minimum === undefined) {
      result.minimum = inputSchema.exclusiveMinimum;
    }
    if (inputSchema.exclusiveMaximum !== undefined && inputSchema.maximum === undefined) {
      result.maximum = inputSchema.exclusiveMaximum;
    }

    for (const [key, value] of Object.entries(inputSchema)) {
      if (!this.ALLOWED_SCHEMA_FIELDS.has(key)) continue;

      if (key === 'type') {
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

    // Remove fields unsupported by Gemini OpenAPI schema protobuf
    delete result.anyOf;
    delete result.oneOf;
    delete result.allOf;
    delete result.not;
    delete result.default;

    if (result.type === 'ARRAY' && !result.items) {
      result.items = { type: 'STRING' };
    }
    if (result.type === 'OBJECT' && !result.properties) {
      result.properties = {};
    }

    return result;
  }

  /**
   * Resolves incoming model name to Antigravity internal model ID
   */
  resolveAntigravityModel(name: string): string {
    const raw = (name || '').toLowerCase().trim();
    const clean = raw.replace(/^antigravity-/, '');

    // Opus models
    if (clean.includes('opus')) {
      return 'claude-opus-4-6-thinking';
    }

    // Sonnet models
    if (clean.includes('sonnet')) {
      return 'claude-sonnet-4-6';
    }

    // Haiku models -> Gemini 3.8 Flash for fast responses
    if (clean.includes('haiku')) {
      return 'gemini-3-flash';
    }

    // Gemini models (legacy or alternative names)
    if (clean.includes('3-pro') || clean === 'gemini-3.1-pro' || clean === 'gemini-3-pro') {
      return 'gemini-3.1-pro-low';
    }
    if (clean.includes('3-flash') || clean === 'gemini-3.8-flash' || clean === 'gemini-3-flash') {
      return 'gemini-3-flash';
    }

    // Direct Antigravity supported models
    const directModels = [
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-thinking',
      'claude-opus-4-5-thinking',
      'gemini-3.1-pro-low',
      'gemini-3-flash',
    ];

    if (directModels.includes(clean)) {
      return clean;
    }

    return 'claude-sonnet-4-6';
  }

  /**
   * Determines header style based on target model
   */
  getHeaderStyle(_model: string): HeaderStyle {
    return 'antigravity';
  }

  /**
   * Builds the Antigravity v1internal API URL
   */
  buildAntigravityUrl(headerStyle: HeaderStyle, stream: boolean): string {
    const baseEndpoint = headerStyle === 'gemini-cli' ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const query = stream ? '?alt=sse' : '';

    return `${baseEndpoint}/v1internal:${method}${query}`;
  }

  /**
   * Checks if model is a thinking model
   */
  isThinkingModel(model: string): boolean {
    return model.includes('-thinking') || model.includes('opus-4-6');
  }

  /**
   * Converts Anthropic content blocks to Antigravity parts
   */
  private convertContentToParts(
    content: string | AnthropicContentBlock[],
    toolUseIdToName: Map<string, string>
  ): AntigravityPart[] {
    if (typeof content === 'string') {
      return content.trim() ? [{ text: content }] : [];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    const parts: AntigravityPart[] = [];

    for (const block of content) {
      if (block.type === 'text') {
        if (block.text) {
          parts.push({ text: block.text });
        }
      } else if (block.type === 'thinking') {
        if (block.thinking) {
          parts.push({ text: block.thinking, thought: true });
        }
      } else if (block.type === 'image') {
        if (block.source?.data && block.source?.media_type) {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        }
      } else if (block.type === 'tool_use') {
        toolUseIdToName.set(block.id, block.name);
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input || {},
          },
        });
      } else if (block.type === 'tool_result') {
        const toolName = toolUseIdToName.get(block.tool_use_id) || `tool_${block.tool_use_id}`;
        let outputContent: string = '';
        if (typeof block.content === 'string') {
          outputContent = block.content;
        } else if (Array.isArray(block.content)) {
          outputContent = block.content
            .map((c) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
            .join('\n');
        } else if (block.content !== undefined && block.content !== null) {
          outputContent = JSON.stringify(block.content);
        }

        parts.push({
          functionResponse: {
            name: toolName,
            response: {
              output: outputContent,
              is_error: block.is_error || false,
            },
          },
        });
      }
    }

    return parts;
  }

  /**
   * Converts Anthropic messages to Antigravity contents and systemInstruction
   */
  convertMessages(
    messages: AnthropicMessage[],
    system?: string | Array<{ type: 'text'; text: string }>
  ): {
    contents: AntigravityContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;

    if (typeof system === 'string' && system.trim()) {
      systemInstruction = { parts: [{ text: system }] };
    } else if (Array.isArray(system) && system.length > 0) {
      const parts = system
        .map((s) => ({ text: s.text }))
        .filter((p) => Boolean(p.text));
      if (parts.length > 0) {
        systemInstruction = { parts };
      }
    }

    const toolUseIdToName = new Map<string, string>();
    const contents: AntigravityContent[] = [];

    for (const msg of messages) {
      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const parts = this.convertContentToParts(msg.content, toolUseIdToName);

      if (parts.length === 0) continue;

      // Merge consecutive messages with identical role to adhere to Gemini alternating roles requirement
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    } else {
      if (contents[0].role === 'model') {
        contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
      }
      if (contents[contents.length - 1].role === 'model') {
        contents.push({ role: 'user', parts: [{ text: 'Please continue.' }] });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Converts Anthropic tools to Antigravity tools
   */
  convertTools(tools?: AnthropicTool[]): AntigravityTool[] | undefined {
    if (!tools || !Array.isArray(tools) || tools.length === 0) {
      return undefined;
    }

    const functionDeclarations = tools.map((tool) => {
      const sanitizedName = (tool.name || 'tool').replace(/[^a-zA-Z0-9_]/g, '_');
      const paramSchema = (this.toGeminiSchema(tool.input_schema) as Record<string, unknown>) || {};
      
      // Ensure schema is a valid OBJECT schema for Gemini API
      if (!paramSchema.type || paramSchema.type !== 'OBJECT') {
        paramSchema.type = 'OBJECT';
      }
      if (!paramSchema.properties || typeof paramSchema.properties !== 'object') {
        paramSchema.properties = {};
      }

      return {
        name: sanitizedName,
        description: tool.description || sanitizedName,
        parameters: paramSchema,
      };
    });

    return [{ functionDeclarations }];
  }

  /**
   * Converts full Anthropic request to Antigravity format
   */
  async convertRequest(
    anthropicReq: AnthropicRequest,
    accessToken: string,
    projectId: string
  ): Promise<{
    url: string;
    init: RequestInit;
    headerStyle: HeaderStyle;
    internalModel: string;
  }> {
    const internalModel = this.resolveAntigravityModel(anthropicReq.model);
    const headerStyle = this.getHeaderStyle(anthropicReq.model);
    const stream = anthropicReq.stream ?? false;

    const { contents, systemInstruction } = this.convertMessages(
      anthropicReq.messages,
      anthropicReq.system
    );
    const tools = this.convertTools(anthropicReq.tools);

    const generationConfig: AntigravityRequest['generationConfig'] = {
      temperature: anthropicReq.temperature,
      maxOutputTokens: anthropicReq.max_tokens,
      topP: anthropicReq.top_p,
      stopSequences: anthropicReq.stop_sequences,
    };

    const isThinking =
      anthropicReq.thinking?.type === 'enabled' || this.isThinkingModel(internalModel);

    if (isThinking) {
      const budget = anthropicReq.thinking?.budget_tokens || 8192;
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      };
      if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= budget) {
        generationConfig.maxOutputTokens = Math.max(
          generationConfig.maxOutputTokens || 0,
          budget + 4096
        );
      }
    }

    const requestPayload: AntigravityRequest = {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    };

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
      internalModel,
      init: {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(wrappedBody),
      },
    };
  }

  /**
   * Converts Antigravity response to Anthropic Message format
   */
  async convertResponse(
    antigravityRes: Response,
    requestedModel: string
  ): Promise<AnthropicResponse> {
    const data: any = await antigravityRes.json();
    const candidates = data.response?.candidates || data.candidates || [];
    const firstCandidate = candidates[0];

    const contentBlocks: AnthropicResponse['content'] = [];
    let stopReason: AnthropicResponse['stop_reason'] = 'end_turn';

    if (firstCandidate?.content?.parts) {
      for (const part of firstCandidate.content.parts) {
        if (part.thought === true) {
          if (part.text) {
            contentBlocks.push({
              type: 'thinking',
              thinking: part.text,
            });
          }
        } else if (typeof part.thought === 'string' && part.thought) {
          contentBlocks.push({
            type: 'thinking',
            thinking: part.thought,
          });
        } else if (typeof part.thinking === 'string' && part.thinking) {
          contentBlocks.push({
            type: 'thinking',
            thinking: part.thinking,
          });
        } else if (part.text) {
          contentBlocks.push({
            type: 'text',
            text: part.text,
          });
        }

        if (part.functionCall) {
          stopReason = 'tool_use';
          contentBlocks.push({
            type: 'tool_use',
            id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        }
      }
    }

    if (firstCandidate?.finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    }

    const usage = data.response?.usageMetadata || data.usageMetadata;

    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.promptTokenCount || 0,
        output_tokens: usage?.candidatesTokenCount || 0,
      },
    };
  }

  /**
   * Converts Antigravity SSE stream to Anthropic SSE format
   */
  async *convertStream(
    stream: ReadableStream,
    requestedModel: string
  ): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    let hasSentMessageStart = false;
    let activeBlockType: 'thinking' | 'text' | 'tool_use' | null = null;
    let currentBlockIndex = 0;
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn';
    let lastCandidatesTokenCount = 0;

    log.info('Starting Anthropic stream conversion', { requestedModel });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.info('Antigravity stream done, closing Anthropic stream');
          // Close open block if any
          if (activeBlockType !== null) {
            yield `event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`;
            activeBlockType = null;
          }

          // Emit message_delta
          yield `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: lastCandidatesTokenCount,
            },
          })}\n\n`;

          // Emit message_stop
          yield `event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`;

          break;
        }

        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const usage = parsed.response?.usageMetadata || parsed.usageMetadata;
          if (usage?.candidatesTokenCount) {
            lastCandidatesTokenCount = usage.candidatesTokenCount;
          }

          // Emit message_start on first valid chunk
          if (!hasSentMessageStart) {
            hasSentMessageStart = true;
            yield `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: usage?.promptTokenCount || 0,
                  output_tokens: 1,
                },
              },
            })}\n\n`;
          }

          const candidates = parsed.response?.candidates || parsed.candidates || [];
          const candidate = candidates[0];

          if (candidate?.finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
          }

          const parts = candidate?.content?.parts || [];

          for (const part of parts) {
            // Check for thinking
            const isThought =
              part.thought === true ||
              typeof part.thought === 'string' ||
              typeof part.thinking === 'string';

            if (isThought) {
              const thoughtText =
                (typeof part.thought === 'string' ? part.thought : '') ||
                (typeof part.thinking === 'string' ? part.thinking : '') ||
                part.text ||
                '';

              if (thoughtText) {
                if (activeBlockType !== 'thinking') {
                  if (activeBlockType !== null) {
                    yield `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: currentBlockIndex,
                    })}\n\n`;
                    currentBlockIndex++;
                  }
                  activeBlockType = 'thinking';
                  yield `event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: {
                      type: 'thinking',
                      thinking: '',
                    },
                  })}\n\n`;
                }

                yield `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: {
                    type: 'thinking_delta',
                    thinking: thoughtText,
                  },
                })}\n\n`;
              }
              continue;
            }

            // Check for regular text
            if (part.text) {
              if (activeBlockType !== 'text') {
                if (activeBlockType !== null) {
                  yield `event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: currentBlockIndex,
                  })}\n\n`;
                  currentBlockIndex++;
                }
                activeBlockType = 'text';
                yield `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: {
                    type: 'text',
                    text: '',
                  },
                })}\n\n`;
              }

              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'text_delta',
                  text: part.text,
                },
              })}\n\n`;
            }

            // Check for function call / tool use
            if (part.functionCall) {
              stopReason = 'tool_use';
              if (activeBlockType !== null) {
                yield `event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: currentBlockIndex,
                })}\n\n`;
                currentBlockIndex++;
              }

              const toolUseId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
              activeBlockType = 'tool_use';

              yield `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: toolUseId,
                  name: part.functionCall.name,
                  input: {},
                },
              })}\n\n`;

              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(part.functionCall.args || {}),
                },
              })}\n\n`;

              yield `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: currentBlockIndex,
              })}\n\n`;

              activeBlockType = null;
              currentBlockIndex++;
            }
          }
        }
      }
    } catch (error) {
      log.error('Anthropic stream reading error', { error: String(error) });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

export const anthropicAdapter = new AnthropicToAntigravityAdapter();
