# CLAUDE.md — UNESCAP Orchestra

## Project Overview

UNESCAP Orchestra is an **agentic loop orchestrator** that acts as an LLM-powered agent backend. It connects to multiple MCP (Model Context Protocol) servers at startup, discovers their tools dynamically, and runs a sequential Reason → Plan → Execute → Observe loop to fulfill user requests. Results are streamed in real-time via **SSE** using an **OpenAI-compatible** API format.

The agent's current skill is **UNESCAP RDTII** — finding, retrieving, and analyzing legal/regulatory documents from government websites across Asia-Pacific countries.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Frontend (React + Vite)        localhost:5173          │
│  ├── SSE stream parser                                 │
│  ├── Markdown rendering (react-markdown + remark-gfm)  │
│  └── Vite proxy → localhost:3000                       │
└──────────────┬─────────────────────────────────────────┘
               │ POST /v1/chat/completions (SSE)
               │ GET  /health
┌──────────────▼─────────────────────────────────────────┐
│  Express Backend                localhost:3000          │
│  ├── Agent Loop (Reason → Plan → Execute → Observe)    │
│  ├── OpenAI SDK (LLM reasoning)                        │
│  ├── SSE Streaming (OpenAI chunk format)                │
│  ├── TypeORM (PostgreSQL)                               │
│  ├── CORS whitelist (localhost:5173 only)               │
│  └── MCP Client (multi-server, auto-reconnect)         │
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
- **Database**: PostgreSQL via TypeORM (`synchronize: true` in dev)
- **Protocol**: MCP (Model Context Protocol) for tool discovery and invocation
- **Validation**: Zod (env vars + config)

### Frontend
- **Framework**: React 19 + Vite 8
- **Styling**: CSS Modules (dark theme, glassmorphism)
- **Markdown**: `react-markdown` + `remark-gfm` (GFM tables, code blocks, lists)
- **Proxy**: Vite dev server proxies `/v1` and `/health` to backend

## Project Structure

```
unescap-orchestra/
├── config.json                  # MCP server configuration (mcpServers array)
├── .env                         # Environment variables (secrets)
├── .env.example                 # Template for .env
├── CLAUDE.md                    # This file — project documentation
├── package.json                 # Backend deps + convenience scripts
├── tsconfig.json
├── src/
│   ├── index.ts                 # Express entry point + bootstrap
│   ├── config/
│   │   └── env.ts               # Zod-validated env + config.json loader
│   ├── agent/
│   │   ├── loop.ts              # Core agentic loop (Reason → Execute → Observe)
│   │   ├── reasoning.ts         # OpenAI SDK calls (reason + reasonStream)
│   │   └── types.ts             # Shared TypeScript types
│   ├── skills/
│   │   └── unescap-rdtii.ts     # Dynamic skill builder (from discovered tools)
│   ├── tools/
│   │   ├── mcp-client.ts        # Multi-server MCP client (session mgmt + auto-reconnect)
│   │   └── registry.ts          # Tool executor registry (dynamic registration)
│   ├── db/
│   │   ├── data-source.ts       # TypeORM DataSource configuration
│   │   ├── client.ts            # DB helper functions (createConversation, saveMessage, etc.)
│   │   ├── migrate.ts           # Schema sync script
│   │   └── entities/
│   │       ├── Conversation.ts  # Conversation entity
│   │       ├── Message.ts       # Message entity
│   │       └── ToolExecution.ts # Tool execution log entity
│   ├── sse/
│   │   └── stream.ts            # SSE helpers (OpenAI chunk format + agent events)
│   └── middleware/
│       └── error-handler.ts     # Express error middleware
└── frontend/
    ├── index.html
    ├── package.json              # Frontend deps (react, react-markdown, etc.)
    ├── vite.config.ts            # Vite config with API proxy to :3000
    └── src/
        ├── main.tsx              # React entry point (StrictMode)
        ├── App.tsx               # Main app — SSE parser, feed state, streaming msg
        ├── App.module.css        # Chat area layout
        ├── api.ts                # API client (health, chat with AbortSignal)
        ├── index.css             # Global CSS variables, dark theme, animations
        ├── types.ts              # Frontend types (ChatMessage, AgentEvent, FeedItem)
        └── components/
            ├── Header.tsx        # Header with MCP health status badge
            ├── Header.module.css
            ├── Welcome.tsx       # Landing screen with suggestion chips
            ├── Welcome.module.css
            ├── ChatMessage.tsx   # Markdown-rendered message bubbles (react-markdown)
            ├── ChatMessage.module.css
            ├── AgentEventCard.tsx # Agent event cards (thinking, tool_call, result, error)
            ├── AgentEventCard.module.css
            ├── ChatInput.tsx     # Auto-resize textarea + Send/Stop buttons
            ├── ChatInput.module.css
            ├── ThinkingDots.tsx  # Animated loading dots
            └── ThinkingDots.module.css
```

## Getting Started

### Prerequisites

- Node.js ≥ 18
- PostgreSQL running locally
- At least one MCP server running

### Setup

```bash
# 1. Install all dependencies (backend + frontend) + sync database schema
npm run setup

# 2. Configure environment
cp .env.example .env
# Edit .env with your database URL and OpenAI endpoint

# 3. Configure MCP servers
# Edit config.json → mcpServers with your server URLs
```

### Running

Open **two terminals** from the project root:

```bash
# Terminal 1 — Backend (port 3000)
npm run dev

# Terminal 2 — Frontend (port 5173)
npm run fe:dev
```

Then open **http://localhost:5173**.

### NPM Scripts (root)

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

### Configuration

#### `.env` — Secrets and runtime config

```env
OPENAI_BASE_URL=http://localhost:4000/v1
OPENAI_MODEL=gpt-4o
DATABASE_URL=postgresql://postgres:password@localhost:5432/unescap_orchestra
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=your_password
PORT=3000
```

#### `config.json` — MCP server connections

```json
{
  "mcpServers": [
    { "name": "unescap-server-1", "url": "http://localhost:8000" },
    { "name": "unescap-server-2", "url": "http://localhost:8001" }
  ]
}
```

## Key Concepts

### Agentic Loop

The core loop in `src/agent/loop.ts` follows a Hermes-inspired pattern:

1. **REASON** — Send conversation history + tools to the LLM
2. **DECIDE** — LLM returns either a final response or tool calls
3. **EXECUTE** — Run tool calls sequentially via MCP
4. **OBSERVE** — Append tool results to context, loop back to REASON
5. **RESPOND** — Stream final answer via SSE when done

Max iterations: 15 (configurable via `MAX_ITERATIONS`).

### MCP Tool Discovery & Session Management

At startup, the orchestrator:

1. Reads `config.json` → `mcpServers` (validated with Zod)
2. Connects to each MCP server (initializes JSON-RPC session via `initialize` + `notifications/initialized`)
3. Calls `tools/list` on each to discover available tools
4. Registers all tools in the executor registry
5. Builds the agent skill (tool definitions + system prompt) dynamically

**Auto-reconnect**: If a tool call returns `404 "Session not found"` (expired session), the client automatically:
1. Re-initializes the session (`initSession`)
2. Refreshes the tool list (`listToolsFromServer`)
3. Retries the tool call once with the new session ID
4. Only throws an error if the retry also fails

Tools are routed to the correct MCP server automatically based on the `tool → server` mapping.

### Embedded Resource Handling (PDF/Binary Downloads)

When an MCP tool returns an `EmbeddedResource` (e.g., from `download_document`), the orchestrator:

1. **Detects** the two-element response: `[metadata, EmbeddedResource]`
2. **Decodes** the base64 blob
3. **Saves** to `downloads/<toolname>_<timestamp>.<ext>` (folder auto-created)
4. **Returns** `{ file_path, metadata }` to the agent

The agent then references the file path in its response to the user. Downloaded files are excluded from git via `.gitignore`.

### SSE Streaming

The `/v1/chat/completions` endpoint streams responses using the OpenAI chat completion chunk format. Custom agent events are also emitted:

- `agent.thinking` — LLM reasoning started (with iteration count)
- `agent.tool_call` — Tool invocation with arguments
- `agent.tool_result` — Tool result with status, timing, and preview
- `agent.error` — Error during reasoning or tool execution
- `agent.done` — Loop completed (with conversation ID and iteration count)

### Frontend Architecture

**SSE Parser**: `App.tsx` parses the SSE stream, handling both OpenAI `data:` chunks and custom `event:` agent events.

**Render order**: The streaming assistant message is kept in a separate `streamingMsg` state (not in `feed`), so it always renders **below** all agent event cards (thinking, tool calls, results). When streaming completes, the message is moved into `feed`.

**Stop button**: Users can abort an ongoing request via the Stop button. This uses `AbortController` to cancel the fetch. Partial content is preserved with a `[Stopped]` indicator.

**Markdown**: Assistant responses are rendered with `react-markdown` + `remark-gfm`, supporting:
- Bold, italic, inline code
- Fenced code blocks
- GFM tables
- Blockquotes
- Lists (ordered/unordered)
- Links (open in new tab)

### CORS & Proxy

- **Vite proxy**: In development, `vite.config.ts` proxies `/v1` and `/health` to `http://localhost:3000` — no CORS issues since the browser talks to Vite's own port.
- **Backend CORS**: Whitelisted to `localhost:5173` and `127.0.0.1:5173` only (not `*`).

### Database

TypeORM entities with `synchronize: true` (auto-creates/updates tables in dev):

- **Conversation** — UUID PK, metadata JSON, timestamps
- **Message** — role, content, tool_calls, tool_call_id
- **ToolExecution** — tool_name, arguments, result, duration_ms, status

## API Endpoints

### `POST /v1/chat/completions`

OpenAI-compatible streaming chat completion. Runs the full agentic loop.

```json
{
  "stream": true,
  "messages": [{ "role": "user", "content": "Find Indonesia's data protection law" }]
}
```

Response: SSE stream with `data:` chunks (OpenAI format) + `event:` agent events.

### `GET /health`

Returns server status including MCP server connections and discovered tools.

```json
{
  "status": "ok",
  "service": "unescap-orchestra",
  "mcp_servers": [
    { "name": "...", "url": "...", "sessionId": "...", "toolCount": 5, "tools": "..." }
  ]
}
```

## Development Guidelines

- **ESM-only** — All imports use `.js` extensions (`import { foo } from "./bar.js"`)
- **TypeORM decorators** — `experimentalDecorators` and `emitDecoratorMetadata` are enabled
- **Zod validation** — Environment variables and config.json are validated at startup
- **Sequential tool execution** — Tools are always called one at a time, never in parallel
- **Fail-fast startup** — If any MCP server is unreachable, the server won't start
- **No hardcoded tools** — All tool definitions come from MCP server discovery
- **React StrictMode** — Frontend runs in StrictMode; state updaters must be idempotent (no mutable flags inside `setFeed` callbacks)
- **CSS Modules** — All component styles use `.module.css` files, no global class names
- **Vite proxy required** — Frontend `fetch('/health')` relies on Vite's proxy; do not remove it from `vite.config.ts`
