/**
 * SSE stream helpers — writes OpenAI-compatible SSE chunks to an Express response.
 */
import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { SSEEventType } from "../agent/types.js";

const COMPLETION_ID_PREFIX = "chatcmpl-";

/**
 * Initialise an SSE response (sets headers + flushes).
 */
export function initSSE(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx
  res.flushHeaders();
}

/**
 * Send an OpenAI-compatible chat.completion.chunk.
 */
export function sendChunk(
  res: Response,
  completionId: string,
  model: string,
  delta: { role?: string; content?: string | null },
  finishReason: string | null = null
): void {
  const chunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };

  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * Send a custom agent SSE event (for observability — thinking, tool calls, etc.).
 */
export function sendAgentEvent(
  res: Response,
  event: SSEEventType,
  data: Record<string, unknown>
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send the terminal [DONE] sentinel and end the response.
 */
export function sendDone(res: Response): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Generate a unique completion ID.
 */
export function makeCompletionId(): string {
  return `${COMPLETION_ID_PREFIX}${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}
