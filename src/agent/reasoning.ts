/**
 * Reasoning module — calls the OpenAI-compatible LLM for agent reasoning.
 *
 * Handles:
 * - Building the request with conversation history + tool definitions
 * - Parsing the LLM response for tool_calls or content
 * - Streaming support for content tokens
 */
import OpenAI from "openai";
import { env } from "../config/env.js";
import type {
  ChatMessage,
  ToolDefinition,
  AssistantMessage,
} from "./types.js";

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY || "",
  baseURL: env.OPENAI_BASE_URL,
});

/**
 * Call the LLM forcing exactly one specific tool call.
 *
 * Used by server-side automation (e.g. auto-extracting provisions after ingest)
 * where we need the model to return structured arguments for a known tool
 * rather than free-form text. Returns the raw JSON arguments string of the
 * first tool call, or null if the model returned none.
 */
export async function callToolForced(
  messages: ChatMessage[],
  tool: ToolDefinition,
): Promise<string | null> {
  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    tools: [tool] as unknown as OpenAI.ChatCompletionTool[],
    tool_choice: {
      type: "function",
      function: { name: tool.function.name },
    } as OpenAI.ChatCompletionToolChoiceOption,
  });

  const tc = response.choices[0]?.message?.tool_calls?.[0];
  return tc?.function?.arguments ?? null;
}

/**
 * Call the LLM asking for a raw JSON object as its message content (no tools).
 *
 * More reliable than forced tool-calls for large/deeply-nested schemas, which
 * some models under-fill when constrained by tool_choice. Returns the message
 * content string (expected to be JSON), or null.
 */
export async function completeJson(messages: ChatMessage[]): Promise<string | null> {
  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    max_tokens: 16000,
    messages: messages as OpenAI.ChatCompletionMessageParam[],
  });
  return response.choices[0]?.message?.content ?? null;
}

/**
 * Call the LLM for a single reasoning step.
 *
 * The LLM receives the full conversation history and available tools,
 * then either:
 *   - Returns content (final answer or intermediate reasoning)
 *   - Returns tool_calls (requesting tool execution)
 *
 * @returns An AssistantMessage with content and/or tool_calls.
 */
export async function reason(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<AssistantMessage> {
  console.log(
    `[reasoning] Calling LLM with ${messages.length} messages, ${tools.length} tools`
  );

  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    tools: tools as unknown as OpenAI.ChatCompletionTool[],
    tool_choice: "auto",
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("LLM returned no choices");
  }

  const msg = choice.message;

  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: msg.content ?? null,
  };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    assistantMessage.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  console.log(
    `[reasoning] LLM response — content: ${msg.content ? `${msg.content.slice(0, 100)}...` : "null"}, ` +
    `tool_calls: ${msg.tool_calls?.length ?? 0}, ` +
    `finish_reason: ${choice.finish_reason}`
  );

  return assistantMessage;
}

/**
 * Call the LLM with streaming — yields content tokens as they arrive.
 *
 * Used for the final response to stream content back to the client via SSE.
 * Does NOT support tool_calls (use `reason()` for tool-calling steps).
 */
export async function* reasonStream(
  messages: ChatMessage[],
): AsyncGenerator<string, void, undefined> {
  console.log(
    `[reasoning] Streaming LLM response with ${messages.length} messages`
  );

  const stream = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}

/**
 * Translate a regulation title into English for consistent de-duplication.
 *
 * Returns the original text unchanged if it is already English or if the
 * translation call fails (best-effort — matching should never block on this).
 */
export async function translateToEnglish(title: string): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;

  try {
    const response = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You translate legal/regulation titles into English. " +
            "Respond with ONLY the English title — no quotes, no notes, no explanation. " +
            "If the title is already English, return it unchanged.",
        },
        { role: "user", content: trimmed },
      ],
    });
    const out = response.choices[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : trimmed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[reasoning] translateToEnglish failed, using original: ${msg}`);
    return trimmed;
  }
}

/**
 * Translate a search query into the native language of the target country.
 *
 * The `search_legal_documents` MCP tool matches against official government
 * document titles, which are published in each country's native language — so
 * an English query for e.g. Indonesia ("personal data protection law") retrieves
 * far worse than its native form ("undang-undang pelindungan data pribadi").
 *
 * Best-effort: returns the original query unchanged if the country already uses
 * English, if the query is empty, or if the translation call fails (retrieval
 * must never block on this).
 *
 * @param query   The user's raw search query.
 * @param country Country name or ISO alpha-2 code (e.g. "Indonesia" or "ID").
 */
export async function translateToNative(query: string, country: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed || !country.trim()) return trimmed;

  try {
    const response = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You translate legal/regulation search queries into the official " +
            "native language of a given country, so they match how government " +
            "documents are titled. You are given a country (name or ISO alpha-2 " +
            "code) and a query. Respond with ONLY the translated query — no " +
            "quotes, no notes, no explanation. If the country's official " +
            "language is English, or the query is already in the native " +
            "language, return it unchanged.",
        },
        { role: "user", content: `Country: ${country.trim()}\nQuery: ${trimmed}` },
      ],
    });
    const out = response.choices[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : trimmed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[reasoning] translateToNative failed, using original: ${msg}`);
    return trimmed;
  }
}
