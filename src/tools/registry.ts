/**
 * Tool registry — maps tool names to their executor functions.
 *
 * Tools are registered dynamically at startup after connecting to
 * all MCP servers and discovering their available tools.
 */
import { callMcpTool, getAllDiscoveredTools } from "./mcp-client.js";
import type { ToolResult } from "../agent/types.js";

export type ToolExecutor = (
  args: Record<string, unknown>
) => Promise<unknown>;

/** Registry of tool name → executor function. */
const registry = new Map<string, ToolExecutor>();

/**
 * Register a tool executor.
 */
export function registerTool(name: string, executor: ToolExecutor): void {
  registry.set(name, executor);
}

/**
 * Execute a tool by name with the given arguments.
 * Returns a ToolResult with timing and status.
 */
export async function executeTool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const executor = registry.get(toolName);

  if (!executor) {
    return {
      tool_call_id: toolCallId,
      tool_name: toolName,
      result: { error: `Unknown tool: ${toolName}` },
      duration_ms: 0,
      status: "error",
    };
  }

  const start = Date.now();
  try {
    const result = await executor(args);
    return {
      tool_call_id: toolCallId,
      tool_name: toolName,
      result,
      duration_ms: Date.now() - start,
      status: "success",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool_call_id: toolCallId,
      tool_name: toolName,
      result: { error: message },
      duration_ms: Date.now() - start,
      status: "error",
    };
  }
}

/**
 * Dynamically register all discovered MCP tools.
 *
 * Called once at startup after `connectAllMcpServers()` completes.
 * Each tool is proxied through `callMcpTool()` which routes to
 * the correct MCP server automatically.
 */
export function registerDiscoveredTools(): void {
  const tools = getAllDiscoveredTools();

  for (const tool of tools) {
    const toolName = tool.function.name;
    registerTool(toolName, (args) => callMcpTool(toolName, args));
  }

  console.log(
    `[registry] Registered ${tools.length} tool(s): ${tools.map((t) => t.function.name).join(", ")}`
  );
}
