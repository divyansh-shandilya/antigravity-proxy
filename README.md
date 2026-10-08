# 🚀 Antigravity Proxy (OpenAI + Anthropic)

<div align="center">

**Unified OpenAI & Anthropic Compatible Gateway for Google Antigravity (Cloud Code) API**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-blue)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange)](https://docs.anthropic.com/en/api/messages)
[![Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-Ready-purple)](https://claude.ai/download)

*Use Google's Antigravity Claude & Gemini models across Claude Desktop, OpenCode, Zed, Cursor, and any OpenAI/Anthropic client.*

</div>

---

## 📖 Overview

**Antigravity Proxy** is a high-performance local proxy that bridges standard **OpenAI** and **Anthropic Messages** API formats to Google's internal **Antigravity (Cloud Code)** service.

It allows you to use powerful frontier models like **Claude Sonnet 4.6**, **Claude Opus 4.6**, and **Gemini 3.8 Flash** with your favorite AI tools without requiring proprietary client modifications.

---

## 🌟 Key Features

- **🔄 Dual Protocol Support**:
  - **OpenAI**: `POST /v1/chat/completions` & `/chat/completions`
  - **Anthropic**: `POST /v1/messages` & `/messages` (with `/messages/count_tokens` support)
- **⚡ Real-Time SSE Streaming**:
  - Full Anthropic event streaming (`message_start`, `content_block_start`, `content_block_delta`, `tool_use`, `message_delta`, `message_stop`)
  - OpenAI streaming chunk conversion
- **🛡️ Concurrency Queue & Upstream Mutex**:
  - Serializes and paces outgoing requests to Google's daily backend with a 250ms spacing interval
  - Completely prevents `429 RESOURCE_EXHAUSTED` concurrency collisions caused by multi-process clients (like Claude Desktop firing parallel title, metadata, and agent prompts)
  - Jittered exponential backoff and cool-down holding on upstream quota spikes
- **🛠️ Robust Tool Calling (Function Calling)**:
  - Automatically translates Anthropic and OpenAI tool schemas to Google Gemini Protobuf JSON format
  - Sanitizes schemas to remove incompatible fields (`anyOf`, `oneOf`, `allOf`, `default`, etc.)
- **🔐 Built-in OAuth Wizard**:
  - Authenticate directly with your Google account via browser OAuth
  - Automatic background access token refresh
- **📊 Admin Dashboard**:
  - Web UI at `http://localhost:3000/admin` to monitor active requests, token metrics, error rates, and latency

---

## 🤖 Supported Models

| Model ID | Display Name | Capabilities |
| :--- | :--- | :--- |
| `claude-sonnet-4-6` / `antigravity-claude-sonnet-4-6` | Claude Sonnet 4.6 | 🛠️ Tools, ⚡ Streaming |
| `claude-opus-4-6` / `antigravity-claude-opus-4-6` | Claude Opus 4.6 | 🧠 Thinking / Reasoning, 🛠️ Tools |
| `gemini-3.8-flash` / `antigravity-gemini-3.8-flash` | Gemini 3.8 Flash | ⚡ High Speed, 🛠️ Tools |
| `gemini-3.1-pro` / `antigravity-gemini-3.1-pro` | Gemini 3.1 Pro | 🔬 Complex Tasks, 🛠️ Tools |

---

## ⚡ Quick Start

### Prerequisites
- [Node.js](https://nodejs.org) 20.0 or higher
- A Google account with Cloud Code / Antigravity access

### 1. Installation
```bash
git clone https://github.com/<your-username>/antigravity-proxy.git
cd antigravity-proxy
npm install
npm run build
```

### 2. Authenticate
Run the setup wizard to log in with your Google account:
```bash
npm run auth
```
*Your browser will open to Google's OAuth consent screen. Credentials are saved locally to your system user profile.*

### 3. Start the Server
```bash
npm start
```
The server will start on `http://localhost:3000`.

---

## 💻 Client Integration Guides

### 🟣 Claude Desktop App (Custom Inference / Gateway)
1. Open **Claude Desktop** Settings -> **Developer** / **Model Provider**.
2. Set Endpoint URL to:
   ```text
   http://localhost:3000
   ```
3. Set API Key to any dummy key (e.g. `sk-ant-antigravity`).
4. Select `claude-sonnet-4-6` or `claude-opus-4-6`.

### 🟢 OpenCode
Add the proxy to your `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antigravity": {
      "name": "Antigravity",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1"
      },
      "models": {
        "antigravity-claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6 (Thinking)",
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-6": {
          "name": "Claude Opus 4.6 (Thinking)",
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "antigravity-gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash (High)",
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "antigravity-gemini-3.1-pro": {
          "name": "Gemini 3.1 Pro (Low)",
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  },
  "model": "antigravity/antigravity-claude-sonnet-4-6"
}
```

### ⚡ Zed IDE
Generate your ready-to-paste Zed configuration:
```bash
npm run generate-zed-config
```
Copy the output into your `~/.config/zed/settings.json`.

### 🖥️ Cursor / VS Code (Continue)
- **API Base URL**: `http://localhost:3000/v1`
- **API Key**: `sk-ant-antigravity`
- **Model Name**: `antigravity-claude-sonnet-4-6` or `gemini-3.8-flash`

---

## 🐳 Docker Deployment

1. Complete host authentication first:
   ```bash
   npm run auth
   ```
2. Build and start with Docker Compose:
   ```bash
   npm run docker:up
   ```
3. To view logs:
   ```bash
   docker logs -f antigravity-proxy
   ```

---

## 📁 Project Structure

```text
├── src/
│   ├── adapters/
│   │   ├── anthropic-adapter.ts   # Anthropic Messages API -> Antigravity translation & SSE streaming
│   │   └── openai-adapter.ts      # OpenAI API -> Antigravity translation & streaming
│   ├── lib/
│   │   ├── antigravity/oauth.ts   # Google Cloud Code OAuth flow
│   │   ├── auth/                  # Account token management, rotation & storage
│   │   └── constants.ts           # Endpoints, headers & tool instructions
│   ├── routes/
│   │   ├── chat.ts                # POST /v1/chat/completions (OpenAI)
│   │   ├── messages.ts            # POST /v1/messages (Anthropic)
│   │   ├── models.ts              # GET /v1/models
│   │   └── health.ts              # GET /health
│   ├── services/
│   │   ├── account-manager.ts     # Multi-account rotation & rate limiting
│   │   └── request-queue.ts       # Promise-chain FIFO queue & upstream concurrency mutex
│   └── server.ts                  # Fastify server bootstrap
├── scripts/
│   ├── auth.ts                    # Interactive CLI OAuth login wizard
│   └── generate-zed-config.ts     # Helper for Zed settings
├── package.json
└── tsconfig.json
```

---

## 📄 License

MIT © [Alessandro Bruno](https://github.com/alessandrobrunoh)
