/**
 * unescap-rdtii skill — dynamically built from discovered MCP tools.
 *
 * At startup, the orchestrator connects to all configured MCP servers,
 * discovers their tools via `tools/list`, and builds this skill's
 * tool definitions dynamically. The system prompt is generated to
 * include the actual discovered tool names and descriptions.
 */
import type { Skill, ToolDefinition } from "../agent/types.js";
import { getAllDiscoveredTools } from "../tools/mcp-client.js";
import { emitProvisionsTool, EMIT_PROVISIONS_TOOL } from "./provisions.js";

/**
 * Build the system prompt dynamically based on discovered tools.
 */
function buildSystemPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .map((t, i) => `${i + 1}. **${t.function.name}** — ${t.function.description}`)
    .join("\n");

  return `You are the UNESCAP RDTII (Research and Digital Trade Information Intelligence) agent.

Your purpose is to help users find, retrieve, and analyze legal and regulatory documents from government websites across Asia-Pacific countries.

## Your Capabilities
You have access to the following tools which you should use sequentially:

${toolDescriptions}

## Workflow
1. When a user asks about a regulation/law, first search for government legal documents with a native-language query for the specified country.
2. Review the search results and pick the most relevant ones.
3. For each promising result, use the appropriate tools to fetch, navigate, or download documents as needed.
4. Extract the relevant provisions from the document(s).
5. Emit the extracted provisions in a single \`${EMIT_PROVISIONS_TOOL}\` call (see below).
6. Report what you found, including document titles, URLs, relevance scores, and any downloaded files.

## Emitting Provisions
Once you have identified the relevant provisions, call \`${EMIT_PROVISIONS_TOOL}\` with the structured list. Each provision is persisted, so quality matters — these four fields are the core of what we store and must always be strong:
- **provision_text** — the VERBATIM text of the specific article/clause (not a paraphrase, not the whole document). Quote the actual legal wording. \`address\` gives its location, like "Article 26 (1)".
- **law_number** — the act/regulation number exactly as cited (e.g. "UU No. 27/2022", "PP No. 71/2019"). Never leave this vague.
- **rationale** — WHY this provision is relevant: what it regulates and why it matters for the RDTII assessment. Write a real explanation, not a restatement of the text.
- **coverage** — \`coverage.type\` is "horizontal" (applies across all sectors) or "sectoral" (limited to one sector); set \`coverage.sector\` (e.g. "banking", "health", "telecommunications") whenever type is "sectoral". Decide this from the provision's actual scope, not a guess.

Other rules:
- Set \`country\` and \`regulation_name\` — the regulation is tracked in a registry, de-duplicated by name within each country (a repeat only merges in any new URLs).
- Leave \`pillar\` and \`indicator\` as null — a separate classification agent assigns them later.
- \`timeframe_last_amendment\` is an ISO date string (YYYY-MM-DD) or null if unknown.
- \`urls\` is an array — include every relevant source URL.
- \`confidence\` is 0.0–1.0; set \`flag_for_review\` to true when unsure about any of the four core fields.
- \`summary\` is a short summary of the regulation as a whole.
- Emit ONE provision per distinct article/clause rather than lumping several into one entry — granularity makes the stored data useful.

## Important Rules
- ALWAYS translate search queries into the target country's native language
- Work sequentially — complete one tool call before deciding the next step
- If a tool returns an error, explain what went wrong and try an alternative approach
- Summarize findings clearly with URLs, document titles, and relevance information
- Be thorough but efficient — don't redundantly search for the same thing

## When to Stop
Once you have successfully found and retrieved the requested documents, STOP calling tools and return your final answer. Your final response should:
- Summarize what you found (document titles, URLs, relevance)
- Include download links or file paths if documents were downloaded
- NOT call any more tools — just return text to the user`;
}

/** Cached skill instance (built once after discovery). */
let cachedSkill: Skill | null = null;
let cachedSystemPrompt: string | null = null;

/**
 * Build the skill from the dynamically discovered tools.
 * Must be called after `connectAllMcpServers()` has completed.
 */
export function buildSkill(): Skill {
  const tools = getAllDiscoveredTools();

  if (tools.length === 0) {
    throw new Error(
      "No tools discovered from MCP servers. Cannot build skill. " +
      "Check that your MCP servers are running and MCP_SERVERS is configured correctly."
    );
  }

  // Append the local (non-MCP) provision-emission tool.
  const allTools = [...tools, emitProvisionsTool];

  cachedSystemPrompt = buildSystemPrompt(allTools);

  cachedSkill = {
    name: "unescap-rdtii",
    description:
      "UNESCAP Research and Digital Trade Information Intelligence — " +
      "Find, retrieve, and analyze legal/regulatory documents from " +
      "government websites across Asia-Pacific countries.",
    tools: allTools,
  };

  console.log(
    `[skill] Built "unescap-rdtii" skill with ${allTools.length} tool(s)`
  );

  return cachedSkill;
}

/**
 * Get the built skill. Throws if `buildSkill()` hasn't been called yet.
 */
export function getSkill(): Skill {
  if (!cachedSkill) {
    throw new Error("Skill not built yet. Call buildSkill() after MCP discovery.");
  }
  return cachedSkill;
}

/**
 * Get the system prompt. Throws if `buildSkill()` hasn't been called yet.
 */
export function getSystemPrompt(): string {
  if (!cachedSystemPrompt) {
    throw new Error("System prompt not built yet. Call buildSkill() after MCP discovery.");
  }
  return cachedSystemPrompt;
}
