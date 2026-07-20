/**
 * Zone-1 pipeline — deterministic retrieval chain over the MCP tools.
 *
 * "Zone-1" is the document-retrieval half of the RDTII skill, served by
 * MCP server-1:
 *   1. search_legal_documents  — find candidate government documents
 *   2. process_search_result   — resolve a search hit to a downloadable file
 *      (or extract download links from the landing page)
 *   3. download_document       — fetch the file (saved to ./downloads by the
 *      MCP client's EmbeddedResource handler)
 *
 * Unlike the agentic loop (src/agent/loop.ts), this module runs the chain
 * deterministically — no LLM in the loop — so the frontend "Run" button gets
 * a predictable list of successfully-retrieved documents to choose from.
 *
 * Ingestion (server-2's `ingest_document`) is intentionally NOT run here;
 * the user first selects which retrieved documents to ingest.
 */
import { callMcpTool } from "../tools/mcp-client.js";
import { recordRegulation } from "../db/client.js";
import { reason } from "../agent/reasoning.js";
import { executeTool } from "../tools/registry.js";
import { getSkill } from "../skills/unescap-rdtii.js";
import { EMIT_PROVISIONS_TOOL } from "../skills/provisions.js";
import type { ChatMessage, ToolDefinition } from "../agent/types.js";

/** A progress event emitted while a Zone-1 run is in flight. */
export type Zone1ProgressEvent =
  | { type: "start"; query: string; country: string; maxIterations: number }
  | { type: "thinking"; iteration: number; thought: string }
  | { type: "tool"; iteration: number; tool: string; phase: "call" | "success" | "error"; detail: string }
  | { type: "retrieve"; iteration: number; document: RetrievedDocument }
  | { type: "iteration_done"; iteration: number; downloadedTotal: number }
  | { type: "done"; result: Zone1RunResult };

/** Callback used to stream {@link Zone1ProgressEvent}s to the client. */
export type Zone1ProgressFn = (event: Zone1ProgressEvent) => void;

/** A single raw hit from `search_legal_documents`. */
interface SearchResult {
  title?: string;
  url?: string;
  domain?: string;
  description?: string;
  country?: string;
  country_code?: string;
  is_document_file?: boolean;
  relevance_score?: number;
  match_reason?: string;
  url_accessible?: boolean;
  http_status?: number;
  [key: string]: unknown;
}

/** A document that Zone-1 successfully retrieved (or tried to). */
export interface RetrievedDocument {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  description: string | null;
  relevanceScore: number | null;
  isDocumentFile: boolean;
  /** "downloaded" — file saved locally; "failed" — could not retrieve. */
  status: "downloaded" | "failed";
  /** Local path to the downloaded file (present when status === "downloaded"). */
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Best-guess ingest input_type for server-2 based on the file extension. */
  inputType: "pdf_file" | "html_file" | null;
  error: string | null;
}

export interface Zone1RunResult {
  query: string;
  country: string;
  searchCount: number;
  attempted: number;
  documents: RetrievedDocument[];
  /** Number of planning/search iterations the run actually performed. */
  iterations: number;
}

/** Shape returned by download_document / process_search_result on success. */
interface DownloadOutcome {
  file_path?: string;
  filePath?: string;
  metadata?: {
    filename?: string;
    mime_type?: string;
    mimeType?: string;
    size_bytes?: number;
    sizeBytes?: number;
    url?: string;
  };
  // process_search_result may instead hand back download links to follow.
  download_urls?: string[];
  downloadUrls?: string[];
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

function inferInputType(mimeType: string | null, filePath: string | null): "pdf_file" | "html_file" | null {
  const mt = (mimeType ?? "").toLowerCase();
  const fp = (filePath ?? "").toLowerCase();
  if (mt.includes("pdf") || fp.endsWith(".pdf")) return "pdf_file";
  if (mt.includes("html") || fp.endsWith(".html") || fp.endsWith(".htm")) return "html_file";
  // .doc/.docx/.rtf are handled server-side as document files; treat like pdf path.
  if (fp.endsWith(".doc") || fp.endsWith(".docx") || fp.endsWith(".rtf")) return "pdf_file";
  return null;
}

/**
 * Coerce whatever `download_document` / `process_search_result` returned into
 * a normalized { filePath, mimeType, sizeBytes } — or null if no file resulted.
 */
function extractDownload(raw: unknown): { filePath: string; mimeType: string | null; sizeBytes: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as DownloadOutcome;
  const filePath = o.file_path ?? o.filePath ?? null;
  if (!filePath) return null;
  const meta = o.metadata ?? {};
  return {
    filePath,
    mimeType: meta.mime_type ?? meta.mimeType ?? null,
    sizeBytes: meta.size_bytes ?? meta.sizeBytes ?? null,
  };
}

/**
 * Normalize the `search_legal_documents` return value into a flat array of
 * SearchResult.
 *
 * The MCP client's extractToolResult (src/tools/mcp-client.ts) returns:
 *   - a single parsed object when the tool emitted one text part,
 *   - an array of RAW JSON STRINGS when it emitted multiple text parts
 *     (the common case — one text part per result),
 *   - or a wrapper object with { results | documents | data }.
 * Handle each, parsing any string entries.
 */
function coerceResult(entry: unknown): SearchResult | null {
  if (!entry) return null;
  if (typeof entry === "string") {
    try {
      const parsed = JSON.parse(entry);
      return parsed && typeof parsed === "object" ? (parsed as SearchResult) : null;
    } catch {
      return null;
    }
  }
  if (typeof entry === "object") return entry as SearchResult;
  return null;
}

function normalizeSearchResults(raw: unknown): SearchResult[] {
  if (Array.isArray(raw)) {
    return raw.map(coerceResult).filter((r): r is SearchResult => r !== null);
  }
  if (typeof raw === "string") {
    const one = coerceResult(raw);
    return one ? [one] : [];
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const nested = o.results ?? o.documents ?? o.data;
    if (Array.isArray(nested)) {
      return nested.map(coerceResult).filter((r): r is SearchResult => r !== null);
    }
    // Single result object.
    if ("url" in o || "title" in o) return [o as SearchResult];
  }
  return [];
}

/**
 * Build the Zone-1 system prompt — a retrieval-only variant of the RDTII agent.
 *
 * Unlike the full chat agent, Zone-1 must STOP after downloading documents: the
 * user picks which ones to ingest afterwards. So we forbid emit_provisions and
 * ingest tools and instruct the model to end once it has downloaded what it can.
 */
function buildZone1Prompt(query: string, country: string, maxDocs: number, tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .map((t, i) => `${i + 1}. ${t.function.name} — ${t.function.description}`)
    .join("\n");

  return `You are the retrieval half ("Zone-1") of the UNESCAP RDTII agent.

Your ONLY job is to FIND and DOWNLOAD official government legal/regulatory
documents for a specific country, then STOP. A human will review the downloaded
files afterwards and choose which to ingest — so you must NOT ingest, classify,
or extract provisions.

## Task
Country: ${country}
Request: "${query}"
Download up to ${maxDocs} distinct, highly-relevant documents.

## Available tools
${toolDescriptions}

## Workflow
1. Search for documents using a query in ${country}'s OFFICIAL/NATIVE language
   (official titles are published in the native language — translate first).
2. Review the results. Pick the most relevant, authoritative (government-domain)
   documents.
3. For direct document files, download them. For landing pages, resolve them to
   a downloadable file, then download.
4. If a search returns little, TRY AGAIN with refined phrasings: the official law
   name, its number/year, synonyms, broader or narrower terms, related regs.
5. Repeat until you have downloaded up to ${maxDocs} good documents or you have
   exhausted reasonable search phrasings.

## Hard rules
- ALWAYS translate the search query into ${country}'s native language.
- Work sequentially — one tool call at a time.
- Do NOT call any ingest, provision-emission, or classification tools.
- When you are done downloading, STOP calling tools and reply with a short plain
  text summary of what you downloaded. Do not ask the user questions.`;
}

/** Best-effort extraction of a downloaded file from an executeTool result. */
function extractDownloadFromToolResult(raw: unknown): {
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
} | null {
  // executeTool wraps MCP output; download_document resolves (via the MCP
  // client's EmbeddedResource handler) to { file_path, metadata } — possibly
  // an array when several resources came back.
  const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
  for (const c of candidates) {
    const one = extractDownload(c);
    if (one) return one;
  }
  return null;
}

/**
 * Run Zone-1 as a REAL internal agentic loop (the same reason→execute→observe
 * cycle as the chat agent in src/agent/loop.ts), but scoped to retrieval and
 * stopped at download. Every document the agent downloads is captured as a
 * {@link RetrievedDocument} so the frontend can present the ingest-selection UI.
 *
 * Progress is streamed via `onProgress` so the UI shows the agent thinking and
 * calling tools live.
 *
 * @param query   The user's raw request (the loop translates it internally).
 * @param country Country name or ISO alpha-2 code.
 * @param maxDocs Target number of documents to download (soft cap in the prompt).
 * @param onProgress Optional callback fired with {@link Zone1ProgressEvent}s.
 * @param maxIterations Hard cap on reason/execute iterations (default 10).
 */
export async function runZone1(
  query: string,
  country: string,
  maxDocs = 8,
  onProgress?: Zone1ProgressFn,
  maxIterations = 10,
): Promise<Zone1RunResult> {
  const emit = (e: Zone1ProgressEvent) => {
    try {
      onProgress?.(e);
    } catch {
      // Progress reporting must never break the run.
    }
  };

  emit({ type: "start", query, country, maxIterations });

  // Retrieval-only toolset: everything discovered EXCEPT ingest/provision tools.
  const allTools = getSkill().tools;
  const tools = allTools.filter((t) => {
    const n = t.function.name;
    return n !== EMIT_PROVISIONS_TOOL && !/ingest/i.test(n);
  });

  const documents: RetrievedDocument[] = [];
  const seenPaths = new Set<string>();
  let searchCount = 0;
  let attempted = 0;
  let docIndex = 0;
  let iteration = 0;

  const messages: ChatMessage[] = [
    { role: "system", content: buildZone1Prompt(query, country, maxDocs, tools) },
    { role: "user", content: `Find and download documents for: ${query} (country: ${country}).` },
  ];

  let isComplete = false;
  while (!isComplete && iteration < maxIterations && documents.length < maxDocs) {
    iteration++;

    // ── REASON ──
    let assistant;
    try {
      assistant = await reason(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[zone1] Reasoning error:`, msg);
      emit({ type: "thinking", iteration, thought: `Reasoning error: ${msg}` });
      break;
    }
    messages.push(assistant);

    if (assistant.content && assistant.content.trim()) {
      emit({ type: "thinking", iteration, thought: assistant.content.trim() });
    }

    // No tool calls → the agent is done retrieving.
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      isComplete = true;
      break;
    }

    // ── EXECUTE each tool call sequentially ──
    for (const toolCall of assistant.tool_calls) {
      const name = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      // process_search_result may pass `result` as a JSON string — normalize.
      if (name === "process_search_result" && typeof args.result === "string") {
        try {
          args.result = JSON.parse(args.result);
        } catch {
          /* keep as-is */
        }
      }

      emit({
        type: "tool",
        iteration,
        tool: name,
        phase: "call",
        detail: summarizeArgs(name, args),
      });

      const toolResult = await executeTool(toolCall.id, name, args);

      if (/search_legal_documents/i.test(name) && toolResult.status === "success") {
        const hits = normalizeSearchResults(toolResult.result);
        searchCount += hits.length;
      }

      // Capture downloaded documents so the UI can offer them for ingest.
      if (toolResult.status === "success") {
        const download =
          /download_document|process_search_result/i.test(name)
            ? extractDownloadFromToolResult(toolResult.result)
            : null;

        if (download && !seenPaths.has(download.filePath)) {
          attempted++;
          seenPaths.add(download.filePath);

          const url =
            typeof args.url === "string"
              ? args.url
              : typeof (args.result as SearchResult)?.url === "string"
                ? String((args.result as SearchResult).url)
                : "";
          const titleFromResult =
            args.result && typeof args.result === "object"
              ? String((args.result as SearchResult).title ?? "")
              : "";

          // Title priority: a real result title, else the source URL, and only
          // as a last resort the local filename. The download_document handler
          // names files "download_document_<timestamp>.pdf" — those generic
          // names are ~84% similar to each other, so if used as the regulation
          // name they collapse DISTINCT laws into one row via the name-similarity
          // dedup in recordRegulation(). URLs are distinct per document, so
          // prefer them over the filename.
          const doc: RetrievedDocument = {
            id: `doc-${docIndex++}`,
            title: titleFromResult || url || filenameFromPath(download.filePath) || `Document ${docIndex}`,
            url,
            domain: (args.result as SearchResult)?.domain ?? null,
            description: (args.result as SearchResult)?.description ?? null,
            relevanceScore:
              typeof (args.result as SearchResult)?.relevance_score === "number"
                ? ((args.result as SearchResult).relevance_score as number)
                : null,
            isDocumentFile: true,
            status: "downloaded",
            filePath: download.filePath,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            inputType: inferInputType(download.mimeType, download.filePath),
            error: null,
          };
          documents.push(doc);
          emit({ type: "retrieve", iteration, document: doc });

          try {
            await recordRegulation({
              country,
              regulationName: doc.title,
              urls: doc.url ? [doc.url] : [],
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[zone1] Failed to record regulation "${doc.title}": ${message}`);
          }
        }
      }

      emit({
        type: "tool",
        iteration,
        tool: name,
        phase: toolResult.status === "error" ? "error" : "success",
        detail:
          toolResult.status === "error"
            ? summarizeResult(toolResult.result)
            : `${toolResult.duration_ms}ms`,
      });

      // Feed the tool result back into the conversation (OBSERVE).
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult.result),
        tool_call_id: toolCall.id,
        name,
      });

      if (documents.length >= maxDocs) break;
    }

    emit({ type: "iteration_done", iteration, downloadedTotal: documents.length });
  }

  const result: Zone1RunResult = {
    query,
    country,
    searchCount,
    attempted,
    documents,
    iterations: iteration,
  };
  emit({ type: "done", result });
  return result;
}

/** Extract a filename from a local file path. */
function filenameFromPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** One-line summary of tool args for the live feed. */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (typeof args.query === "string") return `${name}("${args.query}")`;
  if (typeof args.url === "string") return `${name}(${args.url})`;
  if (args.result && typeof args.result === "object") {
    const r = args.result as SearchResult;
    return `${name}(${r.title ?? r.url ?? "result"})`;
  }
  const json = JSON.stringify(args);
  return `${name}(${json.length > 120 ? json.slice(0, 120) + "…" : json})`;
}

/** One-line summary of a tool result for error feedback. */
function summarizeResult(result: unknown): string {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
}

/**
 * Ingest a previously-retrieved document into the vector store via server-2.
 * Returns the raw MCP response (which includes a job_id).
 */
export async function ingestDocument(params: {
  filePath: string;
  source: string;
  inputType: "pdf_file" | "html_file";
  collection?: string;
  sessionId?: string;
  callbackUrl?: string;
}): Promise<unknown> {
  const args: Record<string, unknown> = {
    source: params.source,
    input_type: params.inputType,
    file_path: params.filePath,
  };
  if (params.collection) args.collection = params.collection;
  if (params.sessionId) args.session_id = params.sessionId;
  if (params.callbackUrl) args.callback_url = params.callbackUrl;

  return callMcpTool("ingest_document", args);
}

/** Check the status of an ingest job (server-2). */
export async function getIngestStatus(jobId: string): Promise<unknown> {
  return callMcpTool("get_ingest_status", { job_id: jobId });
}
