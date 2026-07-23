/**
 * Auto-extract provisions after a document finishes ingesting.
 *
 * The chat agent can extract provisions interactively via the `emit_provisions`
 * tool, but that requires a human in the loop. This module runs the same
 * extraction automatically when an ingest job completes: it reads the exported
 * markdown of the ingested document, forces the LLM to call `emit_provisions`,
 * validates the output against the same Zod schema, and persists it to the
 * `regulations` + `provisions` tables — no chat required.
 *
 * Triggered from the ingest callback (see POST /api/ingest/callback).
 */
import { readFile } from "node:fs/promises";
import { completeJson } from "../agent/reasoning.js";
import { parseEmitProvisions } from "../skills/provisions.js";
import { recordRegulation, saveProvisionsToDb } from "../db/client.js";
import type { ChatMessage } from "../agent/types.js";

/** Cap the markdown sent to the model so we don't blow the context window. */
const MAX_MARKDOWN_CHARS = 120_000;

/**
 * Build the extraction prompt. Mirrors the provision-quality guidance from the
 * chat agent's system prompt, but scoped to a single document whose full text
 * is provided inline.
 */
function buildExtractionPrompt(country: string, source: string): string {
  return `You extract regulatory provisions from a legal/regulatory document for the UNESCAP RDTII assessment.

You are given the FULL TEXT of one document (country: ${country}, source: ${source}).
Identify the relevant provisions and emit them via the emit_provisions tool.

Quality rules — these four fields are the core of what we store:
- provision_text: the VERBATIM text of the specific article/clause (quote the actual legal wording, not a paraphrase, not the whole document). Use "address" for its location, e.g. "Article 26 (1)".
- law_number: the act/regulation number exactly as cited (e.g. "Act 709", "PP No. 71/2019"). Never leave vague.
- rationale: WHY the provision is relevant — what it regulates and why it matters. A real explanation, not a restatement.
- coverage: "horizontal" (applies across all sectors) or "sectoral" (limited to one sector); set coverage.sector when sectoral.

Other rules:
- Set country and regulation_name (used for de-duplicated registry tracking).
- Leave pillar and indicator null — a separate classification agent assigns them.
- timeframe_last_amendment is an ISO date (YYYY-MM-DD) or null.
- urls must include the source URL(s). confidence is 0.0-1.0; set flag_for_review true when unsure.
- Emit ONE provision per distinct article/clause — granularity matters.
- If the document contains no assessable provisions, still call emit_provisions with the single most relevant clause and flag_for_review true.`;
}

/**
 * Strip markdown code fences and any leading/trailing prose so JSON.parse can
 * handle a model reply that wrapped the object in ```json ... ``` or added text.
 */
function stripToJson(raw: string): string {
  let s = raw.trim();
  // Remove ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // Otherwise slice from the first { or [ to the matching last } or ].
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
  const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (start !== -1 && lastBrace !== -1 && lastBrace >= start) {
    s = s.slice(start, lastBrace + 1);
  }
  return s;
}

/**
 * Coerce the model's tool arguments into the shape emit_provisions expects:
 * { country, regulation_name, provisions: [...] }.
 *
 * Handles the common deviations: a `provisions` value returned as a JSON
 * string, the whole payload nested under a single wrapper key, or the model
 * returning the provisions array at the top level. Fills country/regulation_name
 * from context when the model omitted them.
 */
function normalizeArgs(raw: unknown, country: string, source: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Unwrap a single-key envelope, e.g. { emit_provisions: {...} } or { arguments: {...} }.
  const keys = Object.keys(obj);
  if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === "object" && !Array.isArray(obj[keys[0]])) {
    const inner = obj[keys[0]] as Record<string, unknown>;
    if ("provisions" in inner || "regulation_name" in inner) obj = inner;
  }

  // provisions returned as a JSON string → parse it.
  if (typeof obj.provisions === "string") {
    try {
      obj.provisions = JSON.parse(obj.provisions as string);
    } catch {
      /* leave as-is; validation will report it */
    }
  }

  // Top-level array → treat as the provisions list.
  if (Array.isArray(raw) && !Array.isArray(obj.provisions)) {
    obj = { provisions: raw };
  }

  // Backfill country / regulation_name when missing.
  if (typeof obj.country !== "string" || !obj.country.trim()) obj.country = country;
  if (typeof obj.regulation_name !== "string" || !obj.regulation_name.trim()) {
    obj.regulation_name = source;
  }

  return obj;
}

export interface AutoExtractInput {
  /** Path to the exported markdown of the ingested document. */
  markdownPath: string;
  /** Country the document belongs to. */
  country: string;
  /** Versioned source identifier / URL for the document. */
  source: string;
  /** Conversation/session id for traceability (nullable). */
  conversationId?: string | null;
  /** Fallback source URL to attach when the model omits one. */
  url?: string | null;
  /** The ingest job ID this extraction stems from. */
  jobId?: string | null;
}

export interface AutoExtractResult {
  ok: boolean;
  provisionCount: number;
  regulationId?: string;
  error?: string;
}

/**
 * Read an ingested document's markdown and auto-extract + persist provisions.
 * Best-effort: never throws — returns a result describing success/failure so
 * the caller (ingest callback) can log without breaking the callback response.
 */
export async function autoExtractProvisions(
  input: AutoExtractInput,
): Promise<AutoExtractResult> {
  let markdown: string;
  try {
    markdown = await readFile(input.markdownPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provisionCount: 0, error: `read markdown failed: ${msg}` };
  }

  if (!markdown.trim()) {
    return { ok: false, provisionCount: 0, error: "markdown is empty" };
  }

  const text =
    markdown.length > MAX_MARKDOWN_CHARS
      ? markdown.slice(0, MAX_MARKDOWN_CHARS) + "\n\n[...truncated...]"
      : markdown;

  const messages: ChatMessage[] = [
    { role: "system", content: buildExtractionPrompt(input.country, input.source) },
    {
      role: "user",
      content:
        `Document source: ${input.source}\n\n` +
        `Return ONLY a JSON object (no prose, no code fences) with this exact shape:\n` +
        `{"country": string, "regulation_name": string, "provisions": [ ` +
        `{"provision_text": string, "address": string, "law_number": string, ` +
        `"rationale": string, "coverage": {"type": "horizontal"|"sectoral", "sector": string|null}, ` +
        `"timeframe_last_amendment": string|null, "urls": string[], "confidence": number, ` +
        `"flag_for_review": boolean, "summary": string, "pillar": null, "indicator": null } ] }\n` +
        `The "provisions" array MUST contain at least one entry — one per distinct article/clause.\n\n` +
        `----- DOCUMENT TEXT -----\n${text}`,
    },
  ];

  let argsStr: string | null;
  try {
    argsStr = await completeJson(messages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provisionCount: 0, error: `LLM call failed: ${msg}` };
  }

  if (!argsStr) {
    return { ok: false, provisionCount: 0, error: "model returned no content" };
  }

  if (process.env.AUTOEXTRACT_DEBUG) {
    console.error("[auto-extract DEBUG] raw args:", argsStr.slice(0, 800));
  }

  // Strip markdown code fences and any prose around the JSON object.
  const cleaned = stripToJson(argsStr);

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provisionCount: 0, error: `bad JSON: ${msg}` };
  }

  // Some models wrap the real arguments under a single top-level key, or return
  // the provisions array directly. Normalize to the { country, regulation_name,
  // provisions } shape emit_provisions expects.
  parsedArgs = normalizeArgs(parsedArgs, input.country, input.source);

  // Backfill a source URL onto any provision missing one, so schema validation
  // (urls: min 1 URL) doesn't reject an otherwise-good extraction.
  const fallbackUrl = input.url ?? input.source;
  if (
    parsedArgs &&
    typeof parsedArgs === "object" &&
    Array.isArray((parsedArgs as Record<string, unknown>).provisions)
  ) {
    for (const p of (parsedArgs as { provisions: Array<Record<string, unknown>> }).provisions) {
      const urls = p.urls;
      if (!Array.isArray(urls) || urls.length === 0) {
        if (/^https?:\/\//i.test(fallbackUrl)) p.urls = [fallbackUrl];
      }
    }
  }

  let payload;
  try {
    payload = parseEmitProvisions(parsedArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provisionCount: 0, error: `validation failed: ${msg}` };
  }

  try {
    const mergedUrls = [...new Set(payload.provisions.flatMap((p) => p.urls))];
    const outcome = await recordRegulation({
      country: payload.country,
      regulationName: payload.regulation_name,
      lawNumber: payload.provisions[0]?.law_number ?? null,
      urls: mergedUrls,
      jobId: input.jobId ?? null,
    });
    await saveProvisionsToDb(outcome.regulation.id, input.conversationId ?? null, payload.provisions);
    return {
      ok: true,
      provisionCount: payload.provisions.length,
      regulationId: outcome.regulation.id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provisionCount: 0, error: `persist failed: ${msg}` };
  }
}
