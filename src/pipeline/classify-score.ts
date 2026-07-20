/**
 * Classify + score a regulation after it has been ingested and its provisions
 * auto-extracted.
 *
 * The scoring lives on a separate MCP server (unescap-server-3), exposed as the
 * `classify_and_score_regulation_tool`. That tool reads the regulation from the
 * ChromaDB `regulations` collection (keyed by `doc_id`), summarizes it,
 * retrieves relevant RDTII knowledge, and classifies + scores it against
 * Pillar 6/7 indicators — every indicator rule-validated.
 *
 * This module invokes that tool, normalizes the JSON result, and persists the
 * per-indicator scores to the `regulation_scores` table (linked back to the
 * Regulation registry row the auto-extract flow recorded).
 *
 * Triggered from the ingest callback right after auto-extraction completes.
 */
import { callMcpTool } from "../tools/mcp-client.js";
import { saveRegulationScores, type RegulationScoreInput } from "../db/client.js";

/** MCP tool name on unescap-server-3. */
const CLASSIFY_TOOL = "classify_and_score_regulation_tool";

export interface ClassifyScoreInput {
  /** ChromaDB doc_id of the ingested regulation (from the ingest job). */
  docId: string;
  /** Regulation registry id to link the scores to (nullable). */
  regulationId?: string | null;
  /** Conversation / session id for traceability (nullable). */
  conversationId?: string | null;
  /**
   * Economy name — enables reference-score matching during validation
   * (Singapore / Australia / Malaysia only). Pass the country; harmless
   * otherwise.
   */
  economy?: string | null;
}

export interface ClassifyScoreResult {
  ok: boolean;
  indicatorCount: number;
  error?: string;
}

/** Derive the pillar ("6"/"7") from an indicator id like "6.1" / "7.4". */
function pillarFromIndicatorId(id: string): string | null {
  const m = /^(\d+)/.exec(id.trim());
  return m ? m[1] : null;
}

/**
 * Coerce the MCP tool result into a parsed object. `callMcpTool` may hand back
 * the already-parsed object, a JSON string, or a single-element array of a JSON
 * string (see the mcp-client extractToolResult behaviour).
 */
function coerceResult(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Map one indicator entry from the tool payload to a persistable score. */
function toScoreInput(entry: Record<string, unknown>): RegulationScoreInput | null {
  const indicatorId = typeof entry.id === "string" ? entry.id : null;
  if (!indicatorId) return null;

  const validation =
    entry.validation && typeof entry.validation === "object"
      ? (entry.validation as Record<string, unknown>)
      : {};

  const keyEvidence = Array.isArray(entry.key_evidence)
    ? (entry.key_evidence as unknown[]).filter((e): e is string => typeof e === "string")
    : [];

  const issues = Array.isArray(validation.issues)
    ? (validation.issues as unknown[]).filter((e): e is string => typeof e === "string")
    : [];

  return {
    indicatorId,
    indicatorName: typeof entry.name === "string" ? entry.name : null,
    pillar: pillarFromIndicatorId(indicatorId),
    score: typeof entry.score === "number" ? entry.score : null,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    justification: typeof entry.justification === "string" ? entry.justification : null,
    keyEvidence,
    isValid: typeof validation.is_valid === "boolean" ? validation.is_valid : true,
    validationIssues: issues,
    referenceScore:
      typeof validation.reference_score === "number" ? validation.reference_score : null,
    referenceMatch:
      typeof validation.reference_match === "boolean" ? validation.reference_match : null,
  };
}

/**
 * Run classification + scoring for an ingested regulation and persist the
 * results. Best-effort: never throws — returns a result describing
 * success/failure so the caller (ingest callback) can log without breaking.
 */
export async function classifyAndScoreRegulation(
  input: ClassifyScoreInput,
): Promise<ClassifyScoreResult> {
  if (!input.docId) {
    return { ok: false, indicatorCount: 0, error: "missing doc_id" };
  }

  let raw: unknown;
  try {
    raw = await callMcpTool(CLASSIFY_TOOL, {
      doc_id: input.docId,
      economy: input.economy ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, indicatorCount: 0, error: `MCP call failed: ${msg}` };
  }

  const payload = coerceResult(raw);
  if (!payload) {
    return { ok: false, indicatorCount: 0, error: "unparseable tool result" };
  }

  if (typeof payload.error === "string" && payload.error) {
    return { ok: false, indicatorCount: 0, error: `tool error: ${payload.error}` };
  }

  const indicators = Array.isArray(payload.indicators)
    ? (payload.indicators as unknown[])
    : [];

  const scores: RegulationScoreInput[] = [];
  for (const entry of indicators) {
    if (entry && typeof entry === "object") {
      const mapped = toScoreInput(entry as Record<string, unknown>);
      if (mapped) scores.push(mapped);
    }
  }

  const summary = typeof payload.summary === "string" ? payload.summary : null;

  try {
    await saveRegulationScores({
      regulationId: input.regulationId ?? null,
      docId: input.docId,
      conversationId: input.conversationId ?? null,
      summary,
      scores,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, indicatorCount: scores.length, error: `persist failed: ${msg}` };
  }

  // An out-of-scope regulation legitimately returns zero indicators — that's a
  // success, not a failure. We still persist (clearing any stale scores).
  return { ok: true, indicatorCount: scores.length };
}
