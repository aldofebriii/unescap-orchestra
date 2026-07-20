/**
 * Agent types — OpenAI-compatible message types, tool calls, and SSE events.
 */

// ── OpenAI-compatible message types ──

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
  name?: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// ── Tool definitions (OpenAI function-calling format) ──

export interface ToolParameterProperty {
  type: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  /** For `type: "array"` — the schema of each item. */
  items?: ToolParameterProperty;
  /** For `type: "object"` — the schema of each property. */
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

// ── Tool call & result ──

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  duration_ms: number;
  status: "success" | "error";
}

// ── Agent state ──

export interface AgentState {
  conversationId: string;
  messages: ChatMessage[];
  iteration: number;
  maxIterations: number;
  isComplete: boolean;
}

// ── SSE event types ──

export type SSEEventType =
  | "agent.thinking"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.content"
  | "agent.error"
  | "agent.done";

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
}

// ── Request / Response types ──

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  conversation_id?: string;
}

export interface Skill {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

// ── MCP EmbeddedResource types ──

export interface BlobResourceContents {
  uri: string;
  mimeType: string;
  blob: string; // base64-encoded
}

export interface EmbeddedResource {
  type: "resource";
  resource: BlobResourceContents;
}

export interface ToolResultWithResource {
  metadata: {
    success: boolean;
    filename: string;
    mime_type: string;
    size_bytes: number;
    url: string;
  };
  resource: EmbeddedResource;
}

// ── Provision extraction output ──

/**
 * Coverage of a provision — whether it applies horizontally (across all
 * sectors) or to a specific sector. `sector` names the sector when the
 * coverage is "sectoral".
 */
export interface ProvisionCoverage {
  type: "horizontal" | "sectoral";
  /** Name of the sector — required when `type` is "sectoral"; null/omitted for horizontal. */
  sector?: string | null;
}

/**
 * A single extracted regulatory provision.
 *
 * This is the structured output of the extraction workflow. The `pillar`
 * and `indicator` fields are intentionally left `null` at extraction time —
 * they are filled in later by the downstream classification agent.
 */
export interface Provision {
  /** Verbatim text of the provision. */
  provision_text: string;

  /** Act / practice / regulation law number (e.g. "UU No. 27/2022"). */
  law_number: string;

  /** RDTII pillar — null until set by the classification agent. */
  pillar: string | null;

  /** RDTII indicator — null until set by the classification agent. */
  indicator: string | null;

  /** Rationale explaining why the provision is relevant / how it classifies. */
  rationale: string;

  /** Horizontal vs. sectoral coverage, plus sector name when sectoral. */
  coverage: ProvisionCoverage;

  /** Date of last amendment, as an ISO-8601 date string (e.g. "2022-10-17"). */
  timeframe_last_amendment: string | null;

  /** Location within the document, e.g. "article 26 (1)". */
  address: string;

  /** One or more source URLs for the provision. */
  urls: string[];

  /** Extraction confidence, 0.0–1.0. */
  confidence: number;

  /** Whether a human should review this provision. */
  flag_for_review: boolean;

  /** Short summary of the regulation this provision belongs to. */
  summary: string;
}
