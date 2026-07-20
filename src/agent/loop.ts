/**
 * Agent loop — the core agentic execution cycle.
 *
 * Implements a Hermes-inspired loop:
 *   1. RECEIVE  — user message
 *   2. REASON   — call LLM with history + tools
 *   3. PLAN     — LLM decides: respond or call a tool
 *   4. EXECUTE  — run the tool sequentially
 *   5. OBSERVE  — append tool result to context
 *   6. LOOP     — repeat from step 2
 *   7. RESPOND  — stream final answer via SSE
 *
 * Each step emits SSE events for real-time observability.
 */
import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { reason, reasonStream } from "./reasoning.js";
import type {
  AgentState,
  ChatMessage,
  AssistantMessage,
  ToolMessage,
  ToolCall,
} from "./types.js";
import { getSkill, getSystemPrompt } from "../skills/unescap-rdtii.js";
import {
  EMIT_PROVISIONS_TOOL,
  parseEmitProvisions,
  saveProvisions,
} from "../skills/provisions.js";
import { executeTool } from "../tools/registry.js";
import {
  initSSE,
  sendChunk,
  sendAgentEvent,
  sendDone,
  makeCompletionId,
} from "../sse/stream.js";
import {
  createConversation,
  saveMessage,
  saveToolExecution,
  recordRegulation,
  saveProvisionsToDb,
  type RegulationOutcome,
} from "../db/client.js";
import { env } from "../config/env.js";

const MAX_ITERATIONS = env.MAX_ITERATIONS;

/**
 * Run the full agentic loop for a user request, streaming results via SSE.
 */
export async function runAgentLoop(
  userMessages: ChatMessage[],
  conversationId: string | undefined,
  res: Response,
): Promise<void> {
  // ── Setup ──
  const convId = conversationId ?? uuidv4();
  const completionId = makeCompletionId();
  const model = env.OPENAI_MODEL;

  // Initialise SSE
  initSSE(res);

  // Send initial role chunk (OpenAI-compatible)
  sendChunk(res, completionId, model, { role: "assistant", content: "" });

  try {
    // Persist conversation
    await createConversation(convId);

    // Build initial message list with system prompt
    const messages: ChatMessage[] = [
      { role: "system", content: getSystemPrompt() },
      ...userMessages,
    ];

    // Persist user messages
    for (const msg of userMessages) {
      await saveMessage(convId, msg.role, "content" in msg ? (msg.content as string) : null);
    }

    // ── Agentic loop ──
    const state: AgentState = {
      conversationId: convId,
      messages,
      iteration: 0,
      maxIterations: MAX_ITERATIONS,
      isComplete: false,
    };

    while (!state.isComplete && state.iteration < state.maxIterations) {
      state.iteration++;
      console.log(`\n[agent-loop] ── Iteration ${state.iteration}/${state.maxIterations} ──`);

      // ── REASON: Call LLM ──
      sendAgentEvent(res, "agent.thinking", {
        iteration: state.iteration,
        message_count: state.messages.length,
      });

      let assistantMsg: AssistantMessage;
      try {
        assistantMsg = await reason(state.messages, getSkill().tools);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-loop] Reasoning error:`, errMsg);
        sendAgentEvent(res, "agent.error", { error: errMsg, iteration: state.iteration });
        sendChunk(res, completionId, model, {
          content: `\n\n⚠️ Reasoning error: ${errMsg}`,
        });
        break;
      }

      // Append assistant message to history
      state.messages.push(assistantMsg);
      await saveMessage(
        convId,
        "assistant",
        assistantMsg.content,
        assistantMsg.tool_calls
      );

      // ── DECIDE: Tool calls or final response? ──
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        // No tool calls — this is the final response
        console.log(`[agent-loop] No tool calls — streaming final response`);

        if (assistantMsg.content) {
          // Stream the content in chunks for a natural feel
          const chunks = chunkContent(assistantMsg.content);
          for (const chunk of chunks) {
            sendChunk(res, completionId, model, { content: chunk });
          }
        }

        state.isComplete = true;
        break;
      }

      // ── EXECUTE: Run each tool call sequentially ──
      if (assistantMsg.content) {
        // Emit intermediate reasoning text as its own event (NOT a delta chunk)
        // so the frontend renders it as a separate collapsible bubble.
        sendAgentEvent(res, "agent.content", {
          content: assistantMsg.content,
          is_intermediate: true,
        });
      }

      for (const toolCall of assistantMsg.tool_calls) {
        await executeToolCall(
          toolCall,
          state,
          convId,
          completionId,
          model,
          res
        );
      }
    }

    // ── Guard: max iterations reached ──
    if (!state.isComplete && state.iteration >= state.maxIterations) {
      console.warn(`[agent-loop] Max iterations (${state.maxIterations}) reached — generating summary`);
      sendAgentEvent(res, "agent.thinking", {
        iteration: state.iteration + 1,
        message_count: state.messages.length,
        is_final_summary: true,
      });

      // Force final response by calling LLM one last time with all context
      // Remove tool definitions to prevent further tool calls
      try {
        const summaryMsg = await reason(state.messages, []); // No tools = forces final answer
        state.messages.push(summaryMsg);
        await saveMessage(
          convId,
          "assistant",
          summaryMsg.content,
          summaryMsg.tool_calls
        );

        if (summaryMsg.content) {
          const chunks = chunkContent(summaryMsg.content);
          for (const chunk of chunks) {
            sendChunk(res, completionId, model, { content: chunk });
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-loop] Failed to generate summary:`, errMsg);
        sendChunk(res, completionId, model, {
          content:
            "\n\n⚠️ I've reached the maximum number of reasoning steps (15). " +
            "Here's what I've found so far — please let me know if you'd like me to continue.",
        });
      }
    }

    // ── Finalize ──
    sendAgentEvent(res, "agent.done", {
      conversation_id: convId,
      iterations: state.iteration,
    });
    sendChunk(res, completionId, model, {}, "stop");
    sendDone(res);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[agent-loop] Fatal error:`, errMsg);

    // Try to send error via SSE (response may already be closed)
    try {
      sendAgentEvent(res, "agent.error", { error: errMsg });
      sendChunk(res, completionId, model, {
        content: `\n\n❌ An error occurred: ${errMsg}`,
      });
      sendChunk(res, completionId, model, {}, "stop");
      sendDone(res);
    } catch {
      // Response already closed
    }
  }
}

/**
 * Execute a single tool call and append the result to the agent state.
 */
async function executeToolCall(
  toolCall: ToolCall,
  state: AgentState,
  convId: string,
  completionId: string,
  model: string,
  res: Response
): Promise<void> {
  const { name, arguments: argsStr } = toolCall.function;

  // Parse arguments
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    args = {};
    console.warn(`[agent-loop] Failed to parse tool args for ${name}:`, argsStr);
  }

  console.log(`[agent-loop] Executing tool: ${name}`);
  sendAgentEvent(res, "agent.tool_call", {
    tool_call_id: toolCall.id,
    tool: name,
    arguments: args,
  });

  // For process_search_result, the "result" arg may be a string that needs to be an object
  if (name === "process_search_result" && typeof args.result === "string") {
    try {
      args.result = JSON.parse(args.result);
    } catch {
      // Keep as string
    }
  }

  // Execute. `emit_provisions` is a local (non-MCP) tool: validate the LLM's
  // output against the schema, store it for the classification agent, and
  // record the regulation in the de-duplicated registry.
  let toolResult;
  if (name === EMIT_PROVISIONS_TOOL) {
    const start = Date.now();
    try {
      const payload = parseEmitProvisions(args);
      saveProvisions(convId, payload.provisions);

      // Track successfully processed regulation (dedup by name within country).
      const mergedUrls = [
        ...new Set(payload.provisions.flatMap((p) => p.urls)),
      ];
      const outcome = await recordRegulation({
        country: payload.country,
        regulationName: payload.regulation_name,
        lawNumber: payload.provisions[0]?.law_number ?? null,
        urls: mergedUrls,
      });

      // Persist the structured provisions (text, law number, rationale,
      // coverage) linked to the regulation — not just the registry row.
      await saveProvisionsToDb(outcome.regulation.id, convId, payload.provisions);

      toolResult = {
        tool_call_id: toolCall.id,
        tool_name: name,
        result: {
          success: true,
          count: payload.provisions.length,
          registry: describeOutcome(outcome),
          message: `Stored ${payload.provisions.length} provision(s) for classification.`,
        },
        duration_ms: Date.now() - start,
        status: "success" as const,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolResult = {
        tool_call_id: toolCall.id,
        tool_name: name,
        result: { success: false, error: message },
        duration_ms: Date.now() - start,
        status: "error" as const,
      };
    }
  } else {
    toolResult = await executeTool(toolCall.id, name, args);
  }

  console.log(
    `[agent-loop] Tool ${name} completed in ${toolResult.duration_ms}ms — ${toolResult.status}`
  );

  // Emit tool result event
  sendAgentEvent(res, "agent.tool_result", {
    tool_call_id: toolCall.id,
    tool: name,
    status: toolResult.status,
    duration_ms: toolResult.duration_ms,
    result_preview: truncateResult(toolResult.result),
  });

  // No inline chunk for tool status — the agent.tool_result event already carries this info.
  // The frontend renders it as a structured card, not raw text in the response bubble.

  // Persist tool execution
  await saveToolExecution(
    convId,
    name,
    args,
    toolResult.result,
    toolResult.duration_ms,
    toolResult.status
  );

  // Append tool result message to conversation
  const toolMessage: ToolMessage = {
    role: "tool",
    content: JSON.stringify(toolResult.result),
    tool_call_id: toolCall.id,
    name,
  };

  state.messages.push(toolMessage);
  await saveMessage(convId, "tool", toolMessage.content, undefined, toolCall.id, name);
}

/**
 * Summarize a regulation-registry outcome for the tool result payload,
 * so the LLM can tell the user whether it was new, updated, or already known.
 */
function describeOutcome(outcome: RegulationOutcome): Record<string, unknown> {
  const base = {
    country: outcome.regulation.country,
    regulation_name: outcome.regulation.regulationName,
    known_urls: outcome.regulation.urls,
    hit_count: outcome.regulation.hitCount,
  };
  switch (outcome.status) {
    case "created":
      return { ...base, status: "created", note: "New regulation recorded." };
    case "updated":
      return {
        ...base,
        status: "updated",
        added_urls: outcome.addedUrls,
        similarity: Number(outcome.similarity.toFixed(3)),
        note: "Regulation already existed for this country — merged new URL(s).",
      };
    case "exists":
      return {
        ...base,
        status: "exists",
        similarity: Number(outcome.similarity.toFixed(3)),
        note: "Regulation already known for this country with these URLs — nothing to add.",
      };
  }
}

/**
 * Split content into small chunks for natural SSE streaming.
 */
function chunkContent(content: string, chunkSize: number = 20): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Truncate a tool result for SSE preview (avoid sending massive payloads).
 */
function truncateResult(result: unknown, maxLength: number = 500): string {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "… (truncated)";
}
