/**
 * MCP Client — manages connections to multiple MCP servers.
 *
 * Each MCP server gets its own session. At startup, the orchestrator
 * connects to all configured servers, initializes sessions, and
 * discovers available tools via `tools/list`.
 *
 * When a tool is called, the client routes the request to the
 * correct server based on the tool → server mapping built during discovery.
 *
 * Session management: if a session expires (404 "Session not found"),
 * the client automatically re-initializes and retries the tool call once.
 */
import { mcpServers, type McpServerConfig } from "../config/env.js";
import type { ToolDefinition, ToolResultWithResource } from "../agent/types.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

// ── Per-server session state ──

interface McpServerConnection {
  config: McpServerConfig;
  sessionId: string | null;
  tools: ToolDefinition[];
}

/** All active MCP server connections, keyed by server name. */
const connections = new Map<string, McpServerConnection>();

/** Reverse lookup: tool name → server name. */
const toolToServer = new Map<string, string>();

// ── JSON-RPC response types ──

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: McpToolSchema[];
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

// ── Connection lifecycle ──

/**
 * Initialize a single MCP server session.
 * Sends `initialize` + `notifications/initialized` per MCP protocol.
 */
async function initSession(config: McpServerConfig): Promise<McpServerConnection> {
  console.log(`[mcp-client] Connecting to "${config.name}" at ${config.url} ...`);

  const initPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "unescap-orchestra",
        version: "1.0.0",
      },
    },
  };

  const response = await fetch(`${config.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initPayload),
  });

  if (!response.ok) {
    throw new Error(
      `MCP init failed for "${config.name}": ${response.status} ${response.statusText}`
    );
  }

  const sessionId = response.headers.get("mcp-session-id");

  // Send initialized notification
  await fetch(`${config.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  console.log(
    `[mcp-client] ✔ Session for "${config.name}": ${sessionId ?? "no-session-id"}`
  );

  return {
    config,
    sessionId,
    tools: [],
  };
}

/**
 * Discover tools from a single MCP server via `tools/list`.
 */
async function listToolsFromServer(conn: McpServerConnection): Promise<ToolDefinition[]> {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };

  const response = await fetch(`${conn.config.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(conn.sessionId ? { "Mcp-Session-Id": conn.sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `tools/list failed for "${conn.config.name}": ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  let data: JsonRpcResponse;

  if (contentType.includes("text/event-stream")) {
    data = await parseSseToJsonRpc(response);
  } else {
    data = (await response.json()) as JsonRpcResponse;
  }

  if (data.error) {
    throw new Error(
      `tools/list error for "${conn.config.name}": ${data.error.message}`
    );
  }

  const mcpTools = data.result?.tools ?? [];

  // Convert MCP tool schema → OpenAI ToolDefinition format
  const tools: ToolDefinition[] = mcpTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: {
        type: "object" as const,
        properties: (t.inputSchema?.properties ?? {}) as Record<
          string,
          { type: string; description?: string; enum?: string[]; default?: unknown }
        >,
        required: (t.inputSchema?.required as string[] | undefined) ?? [],
      },
    },
  }));

  return tools;
}

/**
 * Re-initialize a session for a single server and refresh its tools.
 * Called automatically when a session expires mid-request.
 */
async function reconnectServer(serverName: string): Promise<McpServerConnection> {
  console.log(`[mcp-client] 🔄 Reconnecting to "${serverName}"...`);

  const existing = connections.get(serverName);
  if (!existing) {
    throw new Error(`Cannot reconnect unknown server: ${serverName}`);
  }

  const conn = await initSession(existing.config);
  const tools = await listToolsFromServer(conn);
  conn.tools = tools;

  // Update maps
  connections.set(serverName, conn);
  for (const tool of tools) {
    toolToServer.set(tool.function.name, serverName);
  }

  console.log(`[mcp-client] ✅ Reconnected to "${serverName}" — session: ${conn.sessionId}`);
  return conn;
}

/**
 * Connect to ALL configured MCP servers, initialize sessions,
 * and discover tools. Must be called once at startup before
 * the Express server begins accepting requests.
 *
 * @returns The total number of tools discovered across all servers.
 */
export async function connectAllMcpServers(): Promise<number> {
  const servers = mcpServers;

  console.log(`\n[mcp-client] Connecting to ${servers.length} MCP server(s)...\n`);

  for (const serverConfig of servers) {
    try {
      // 1. Initialize session
      const conn = await initSession(serverConfig);

      // 2. Discover tools
      const tools = await listToolsFromServer(conn);
      conn.tools = tools;

      // 3. Store connection
      connections.set(serverConfig.name, conn);

      // 4. Build reverse lookup
      for (const tool of tools) {
        const toolName = tool.function.name;
        if (toolToServer.has(toolName)) {
          console.warn(
            `[mcp-client] ⚠ Tool "${toolName}" already registered from ` +
            `"${toolToServer.get(toolName)}", overwriting with "${serverConfig.name}"`
          );
        }
        toolToServer.set(toolName, serverConfig.name);
      }

      console.log(
        `[mcp-client] ✔ "${serverConfig.name}" — ${tools.length} tool(s): ` +
        tools.map((t) => t.function.name).join(", ")
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcp-client] ✖ Failed to connect to "${serverConfig.name}": ${msg}`);
      throw err; // Fail fast — all servers must be reachable at startup
    }
  }

  const totalTools = Array.from(connections.values()).reduce(
    (sum, c) => sum + c.tools.length,
    0
  );

  console.log(
    `\n[mcp-client] ✅ All servers connected. ${totalTools} tool(s) discovered across ${connections.size} server(s).\n`
  );

  return totalTools;
}

// ── Tool invocation ──

/**
 * Perform the raw HTTP tool call to an MCP server.
 */
async function doToolCall(
  conn: McpServerConnection,
  toolName: string,
  args: Record<string, unknown>
): Promise<Response> {
  const callId = Date.now();
  const payload = {
    jsonrpc: "2.0",
    id: callId,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  return fetch(`${conn.config.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(conn.sessionId ? { "Mcp-Session-Id": conn.sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Check if an HTTP response body indicates a session-not-found error.
 */
function isSessionNotFound(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const parsed = JSON.parse(body);
    const msg: string = parsed?.error?.message ?? "";
    return msg.toLowerCase().includes("session not found") ||
           msg.toLowerCase().includes("session expired");
  } catch {
    return body.toLowerCase().includes("session not found");
  }
}

/**
 * Call a tool on the correct MCP server (determined by the tool → server mapping).
 *
 * Auto-reconnects once if the server returns a session-not-found error.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const serverName = toolToServer.get(toolName);
  if (!serverName) {
    throw new Error(`No MCP server registered for tool: ${toolName}`);
  }

  let conn = connections.get(serverName);
  if (!conn) {
    throw new Error(`MCP server connection not found: ${serverName}`);
  }

  console.log(
    `[mcp-client] Calling "${toolName}" on "${serverName}"`,
    JSON.stringify(args).slice(0, 200)
  );

  // ── First attempt ──
  let response = await doToolCall(conn, toolName, args);

  // ── Auto-reconnect on session expiry ──
  if (!response.ok) {
    const body = await response.text();

    if (isSessionNotFound(response.status, body)) {
      console.warn(
        `[mcp-client] ⚠ Session expired for "${serverName}", reconnecting...`
      );

      // Re-init session and retry once
      conn = await reconnectServer(serverName);
      response = await doToolCall(conn, toolName, args);

      if (!response.ok) {
        const retryBody = await response.text();
        throw new Error(
          `MCP tool call failed after reconnect (${toolName} on ${serverName}): ${response.status} — ${retryBody}`
        );
      }
    } else {
      throw new Error(
        `MCP tool call failed (${toolName} on ${serverName}): ${response.status} — ${body}`
      );
    }
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    return await extractToolResult(await parseSseToJsonRpc(response), toolName);
  }

  const result = (await response.json()) as JsonRpcResponse;
  return extractToolResult(result, toolName);
}

// ── Accessors ──

/**
 * Get all discovered tool definitions (across all servers).
 * Used by the skill module to build the tool list for the LLM.
 */
export function getAllDiscoveredTools(): ToolDefinition[] {
  const allTools: ToolDefinition[] = [];
  for (const conn of connections.values()) {
    allTools.push(...conn.tools);
  }
  return allTools;
}

/**
 * Get connection info for all servers (for health/status endpoints).
 */
export function getConnectionStatus(): Array<{
  name: string;
  url: string;
  sessionId: string | null;
  toolCount: number;
  tools: string[];
}> {
  return Array.from(connections.values()).map((conn) => ({
    name: conn.config.name,
    url: conn.config.url,
    sessionId: conn.sessionId,
    toolCount: conn.tools.length,
    tools: conn.tools.map((t) => t.function.name),
  }));
}

// ── Helpers ──

/** Downloads folder path (relative to project root) */
const DOWNLOADS_DIR = join(process.cwd(), "downloads");

/**
 * Extract the useful result from an MCP JSON-RPC response.
 * Handles both text content and EmbeddedResource (blob PDFs).
 */
async function extractToolResult(data: JsonRpcResponse, toolName: string): Promise<unknown> {
  if (data.error) {
    throw new Error(`MCP tool error (${toolName}): ${data.error.message}`);
  }

  const content = data.result?.content;
  if (!Array.isArray(content)) {
    return data.result;
  }

  const textParts: string[] = [];
  const resourceResults: Array<{ file_path: string; metadata: unknown }> = [];

  // Process each content item by type
  for (const item of content) {
    if (!item || typeof item !== "object" || !("type" in item)) continue;

    if (item.type === "text" && "text" in item && typeof item.text === "string") {
      textParts.push(item.text);
    } else if (item.type === "resource" && "resource" in item) {
      // Extract metadata from accumulated text (assume JSON metadata comes before resource)
      let metadata: unknown = {};
      if (textParts.length > 0) {
        try {
          metadata = JSON.parse(textParts[textParts.length - 1]);
        } catch {
          // Not JSON, use empty metadata
        }
      }

      const result = { metadata, resource: item } as unknown as ToolResultWithResource;
      const saved = await handleEmbeddedResource(result, toolName);
      resourceResults.push(saved);
    }
  }

  // Return based on what we found
  if (resourceResults.length > 0) {
    // If single resource, return it directly; otherwise return array
    return resourceResults.length === 1 ? resourceResults[0] : resourceResults;
  }

  // No resources — return text content
  if (textParts.length === 1) {
    try {
      return JSON.parse(textParts[0]);
    } catch {
      return textParts[0];
    }
  }

  return textParts.length > 0 ? textParts : data.result;
}

/**
 * Handle EmbeddedResource with blob — decode base64, save to disk, return path.
 */
async function handleEmbeddedResource(
  result: ToolResultWithResource,
  toolName: string
): Promise<{ file_path: string; metadata: ToolResultWithResource["metadata"] }> {
  const { metadata, resource } = result;
  const { blob, mimeType } = resource.resource;

  // Ensure downloads directory exists
  await mkdir(DOWNLOADS_DIR, { recursive: true });

  // Generate filename
  const timestamp = Date.now();
  const ext = mimeType.includes("pdf") ? "pdf" : mimeType.split("/")[1] ?? "bin";
  const filename = `${toolName}_${timestamp}.${ext}`;
  const filePath = join(DOWNLOADS_DIR, filename);

  // Decode base64 and write to disk
  const buffer = Buffer.from(blob, "base64");
  await writeFile(filePath, buffer);

  console.log(
    `[mcp-client] ✔ Saved ${metadata.mime_type} (${metadata.size_bytes} bytes) → ${filePath}`
  );

  return {
    file_path: filePath,
    metadata: {
      ...metadata,
      filename,
    },
  };
}

/**
 * Parse an SSE response body into a JSON-RPC result.
 */
async function parseSseToJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  const lines = text.split("\n");
  let lastData = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      lastData = line.slice(6);
    }
  }

  if (!lastData) {
    return { result: {} };
  }

  try {
    return JSON.parse(lastData) as JsonRpcResponse;
  } catch {
    return { result: {} };
  }
}

/**
 * Reset all MCP sessions (useful for reconnection).
 */
export function resetAllSessions(): void {
  connections.clear();
  toolToServer.clear();
}
