# UNESCAP Orchestra 🎭

> An agentic loop orchestrator that acts as an LLM-powered agent backend with dynamic MCP tool integration

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://reactjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Required-336791.svg)](https://www.postgresql.org/)

## Overview

UNESCAP Orchestra is an **agentic loop orchestrator** that connects to multiple MCP (Model Context Protocol) servers, discovers their tools dynamically, and runs a sequential **Reason → Plan → Execute → Observe** loop to fulfill user requests. Results are streamed in real-time via **Server-Sent Events (SSE)** using an **OpenAI-compatible** API format.

### Current Skill: UNESCAP RDTII
Finding, retrieving, and analyzing legal/regulatory documents from government websites across Asia-Pacific countries.

## Features

- 🔄 **Agentic Loop** — Autonomous Reason → Execute → Observe cycles (max 15 iterations)
- 🔌 **Dynamic Tool Discovery** — Auto-discovers tools from multiple MCP servers at startup
- 🔁 **Auto-Reconnect** — Session management with automatic reconnection on timeout
- 📡 **SSE Streaming** — Real-time updates via OpenAI-compatible streaming format
- 🎯 **Tool Routing** — Intelligent routing of tool calls to the correct MCP server
- 💾 **Persistent Storage** — TypeORM + PostgreSQL for conversation and execution history
- 📥 **Binary Downloads** — Automatic handling of PDF/binary embedded resources
- 🎨 **Modern UI** — React 19 + Vite with dark theme and Markdown rendering

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Frontend (React + Vite)        localhost:5173         │
│  ├── SSE stream parser                                 │
│  ├── Markdown rendering (react-markdown + remark-gfm)  │
│  └── Vite proxy → localhost:3000                       │
└──────────────┬─────────────────────────────────────────┘
               │ POST /v1/chat/completions (SSE)
               │ GET  /health
┌──────────────▼─────────────────────────────────────────┐
│  Express Backend                localhost:3000         │
│  ├── Agent Loop (Reason → Plan → Execute → Observe)   │
│  ├── OpenAI SDK (LLM reasoning)                        │
│  ├── SSE Streaming (OpenAI chunk format)              │
│  ├── TypeORM (PostgreSQL)                             │
│  ├── CORS whitelist (localhost:5173 only)             │
│  └── MCP Client (multi-server, auto-reconnect)        │
└──────────┬──────────┬──────────┬───────────────────────┘
           │          │          │
     ┌─────▼──┐ ┌─────▼──┐ ┌────▼───┐
     │ MCP #1 │ │ MCP #2 │ │ MCP #3 │
     └────────┘ └────────┘ └────────┘
```

## Tech Stack

### Backend
- **Runtime**: Node.js (ESM)
- **Language**: TypeScript (strict mode, decorators enabled)
- **Framework**: Express 4
- **LLM**: OpenAI SDK (any OpenAI-compatible endpoint)
- **Database**: PostgreSQL via TypeORM
- **Protocol**: MCP (Model Context Protocol)
- **Validation**: Zod (env vars + config)

### Frontend
- **Framework**: React 19 + Vite 8
- **Styling**: CSS Modules (dark theme, glassmorphism)
- **Markdown**: `react-markdown` + `remark-gfm`
- **Proxy**: Vite dev server proxies `/v1` and `/health` to backend

## Quick Start

### Prerequisites

- Node.js ≥ 18
- PostgreSQL running locally
- Python (for some of the MCP tool dependencies if applicable)

### 1. Start the MCP Servers

Before starting the UNESCAP Orchestra, you must run the required MCP servers in separate terminals. Based on the default `config.json`, open three separate terminals and start them:

```bash
# Terminal 1 - mcp-unescap-tool-1 (Port 8000)
cd ../mcp-unescap-tool-1
# Start the server according to its instructions (e.g., node, python, or npm run)
```

```bash
# Terminal 2 - extraction_html_pdf_tool (Port 8420)
cd ../extraction_html_pdf_tool
# Start the server according to its instructions
```

```bash
# Terminal 3 - UNESCAPtool3 (Port 8912)
cd ../UNESCAPtool3
# Start the server according to its instructions
```

### 2. Installation (UNESCAP Orchestra)

In a new terminal, navigate to the `unescap-orchestra` directory:

```bash
# 1. Install all dependencies (backend + frontend) + sync database schema
npm run setup

# 2. Configure environment variables
cp .env.example .env
# Edit .env with your database URL and OpenAI endpoint

# 3. Configure MCP servers
# Edit config.json with your MCP server URLs if they differ from the defaults
```

### Configuration

#### `.env` — Secrets and runtime config

```env
OPENAI_BASE_URL=http://localhost:4000/v1
OPENAI_MODEL=gpt-4o
DATABASE_URL=postgresql://postgres:password@localhost:5432/unescap_orchestra
PORT=3000
```

#### `config.json` — MCP server connections

```json
{
  "mcpServers": [
    {
      "name": "unescap-server-1",
      "url": "http://localhost:8000"
    },
    {
      "name": "unescap-server-2",
      "url": "http://localhost:8420"
    },
    {
      "name": "unescap-server-3",
      "url": "http://localhost:8912"
    }
  ]
}
```

### 3. Running the Orchestra

Open **two more terminals** inside the `unescap-orchestra` directory:

```bash
# Terminal 4 — Backend (port 3000)
npm run dev

# Terminal 5 — Frontend (port 5173)
npm run fe:dev
```

Then open **http://localhost:5173** in your browser.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start backend with hot-reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled backend |
| `npm run migrate` | Sync TypeORM schema to database |
| `npm run setup` | Install all deps (backend + frontend) + migrate |
| `npm run fe:dev` | Start Vite frontend dev server |
| `npm run fe:build` | Build frontend for production |
| `npm run fe:install` | Install frontend dependencies only |

## API Endpoints

### `POST /v1/chat/completions`

OpenAI-compatible streaming chat completion. Runs the full agentic loop.

**Request:**
```json
{
  "stream": true,
  "messages": [
    { "role": "user", "content": "Find Indonesia's data protection law" }
  ]
}
```

**Response:** SSE stream with:
- `data:` chunks (OpenAI format)
- `event:` agent events (`agent.thinking`, `agent.tool_call`, `agent.tool_result`, `agent.error`, `agent.done`)

### `GET /health`

Returns server status including MCP server connections and discovered tools.

**Response:**
```json
{
  "status": "ok",
  "service": "unescap-orchestra",
  "mcp_servers": [
    {
      "name": "unescap-server-1",
      "url": "http://localhost:8000",
      "sessionId": "abc123",
      "toolCount": 5,
      "tools": "search_legal_documents, download_document, ..."
    }
  ]
}
```

## Project Structure

```
unescap-orchestra/
├── config.json                  # MCP server configuration
├── .env                         # Environment variables (secrets)
├── .env.example                 # Template for .env
├── CLAUDE.md                    # Detailed project documentation
├── README.md                    # This file
├── package.json                 # Backend deps + scripts
├── tsconfig.json
├── src/
│   ├── index.ts                 # Express entry point
│   ├── config/
│   │   └── env.ts               # Zod-validated env loader
│   ├── agent/
│   │   ├── loop.ts              # Core agentic loop
│   │   ├── reasoning.ts         # OpenAI SDK calls
│   │   └── types.ts             # Shared types
│   ├── skills/
│   │   └── unescap-rdtii.ts     # Dynamic skill builder
│   ├── tools/
│   │   ├── mcp-client.ts        # Multi-server MCP client
│   │   └── registry.ts          # Tool executor registry
│   ├── db/
│   │   ├── data-source.ts       # TypeORM configuration
│   │   ├── client.ts            # DB helper functions
│   │   ├── migrate.ts           # Schema sync script
│   │   └── entities/            # TypeORM entities
│   ├── sse/
│   │   └── stream.ts            # SSE helpers
│   └── middleware/
│       └── error-handler.ts     # Express error middleware
└── frontend/
    ├── package.json             # Frontend deps
    ├── vite.config.ts           # Vite config with proxy
    └── src/
        ├── main.tsx             # React entry point
        ├── App.tsx              # Main app component
        ├── api.ts               # API client
        └── components/          # React components
```

## Key Concepts

### Agentic Loop

The core loop follows a Hermes-inspired pattern:

1. **REASON** — Send conversation history + tools to the LLM
2. **DECIDE** — LLM returns either a final response or tool calls
3. **EXECUTE** — Run tool calls sequentially via MCP
4. **OBSERVE** — Append tool results to context, loop back to REASON
5. **RESPOND** — Stream final answer via SSE when done

Max iterations: **15** (configurable via `MAX_ITERATIONS`)

### MCP Tool Discovery

At startup, the orchestrator:

1. Reads `config.json` → `mcpServers`
2. Connects to each MCP server (initializes JSON-RPC session)
3. Calls `tools/list` on each to discover available tools
4. Registers all tools in the executor registry
5. Builds the agent skill dynamically

**Auto-reconnect**: If a tool call returns `404 "Session not found"`, the client automatically re-initializes the session and retries the call.

### Embedded Resource Handling

When an MCP tool returns an `EmbeddedResource` (e.g., PDF download):

1. **Detects** the two-element response: `[metadata, EmbeddedResource]`
2. **Decodes** the base64 blob
3. **Saves** to `downloads/<toolname>_<timestamp>.<ext>`
4. **Returns** `{ file_path, metadata }` to the agent

### SSE Streaming

Custom agent events are emitted during execution:

- `agent.thinking` — LLM reasoning started (with iteration count)
- `agent.tool_call` — Tool invocation with arguments
- `agent.tool_result` — Tool result with status, timing, and preview
- `agent.error` — Error during reasoning or tool execution
- `agent.done` — Loop completed

## Development Guidelines

- **ESM-only** — All imports use `.js` extensions
- **TypeORM decorators** — `experimentalDecorators` enabled
- **Zod validation** — Env vars and config validated at startup
- **Sequential execution** — Tools called one at a time
- **Fail-fast startup** — Server won't start if MCP servers unreachable
- **No hardcoded tools** — All tool definitions from MCP discovery
- **React StrictMode** — State updaters must be idempotent
- **CSS Modules** — Component styles use `.module.css` files

## Database Entities

TypeORM entities with `synchronize: true` (auto-creates tables in dev):

- **Conversation** — UUID PK, metadata JSON, timestamps
- **Message** — role, content, tool_calls, tool_call_id
- **ToolExecution** — tool_name, arguments, result, duration_ms, status

## CORS & Proxy

- **Vite proxy**: In development, `vite.config.ts` proxies `/v1` and `/health` to `http://localhost:3000`
- **Backend CORS**: Whitelisted to `localhost:5173` and `127.0.0.1:5173` only

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[Add your license here]

## Support

For detailed documentation, see [CLAUDE.md](./CLAUDE.md)

---

Built with ❤️ for UNESCAP
