/**
 * UNESCAP Orchestra — Express server entry point.
 *
 * At startup:
 *   1. Connect to all configured MCP servers
 *   2. Discover tools via tools/list
 *   3. Register tools in the executor registry
 *   4. Build the agent skill from discovered tools
 *   5. Start the Express server
 *
 * Exposes an OpenAI-compatible POST /v1/chat/completions endpoint
 * that runs the agentic loop and streams results via SSE.
 */
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { runAgentLoop } from "./agent/loop.js";
import { errorHandler } from "./middleware/error-handler.js";
import { initializeDatabase, closeDatabase } from "./db/client.js";
import type { ChatCompletionRequest } from "./agent/types.js";
import { connectAllMcpServers, getConnectionStatus } from "./tools/mcp-client.js";
import { registerDiscoveredTools } from "./tools/registry.js";
import { buildSkill } from "./skills/unescap-rdtii.js";
import {
  listRegulations,
  updateJobFromCallback,
  listJobs,
  getJob,
  createSession,
  finalizeSession,
  listSessions,
  getSession,
  listSessionDocuments,
  linkIngestJob,
  getSessionDocumentByJob,
  listProvisions,
  listRegulationScores,
  type CallbackPayload,
  type SessionDocumentInput,
} from "./db/client.js";
import { runZone1, ingestDocument, getIngestStatus } from "./pipeline/zone1.js";
import { autoExtractProvisions } from "./pipeline/auto-extract.js";
import { classifyAndScoreRegulation } from "./pipeline/classify-score.js";
import { AppDataSource } from "./db/data-source.js";
import { Regulation } from "./db/entities/Regulation.js";
import { promises as fs } from "node:fs";

import { v4 as uuidv4 } from "uuid";

/** Best-effort extraction of a job_id from the ingest_document MCP response. */
function extractJobId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  const direct = o.job_id ?? o.jobId;
  if (typeof direct === "string") return direct;
  for (const key of ["result", "data"]) {
    const nested = o[key];
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      const id = n.job_id ?? n.jobId;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

const app = express();

// ── Middleware ──
app.use(cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "10mb" }));

// ── Health check (includes MCP server status) ──
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "unescap-orchestra",
    timestamp: new Date().toISOString(),
    mcp_servers: getConnectionStatus(),
  });
});

// ── Regulation registry (successfully processed regulations) ──
app.get("/regulations", async (req, res) => {
  const country = typeof req.query.country === "string" ? req.query.country : undefined;
  const rows = await listRegulations(country);
  res.json({ count: rows.length, regulations: rows });
});

// ── Document detail API (for modal/detail view) ──
app.get("/api/documents/:jobId/detail", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) {
    res.status(400).json({ error: "jobId is required." });
    return;
  }

  const job = await getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found.` });
    return;
  }

  // Read markdown content if available
  let markdown: string | null = null;
  if (job.markdownPath) {
    try {
      markdown = await fs.readFile(job.markdownPath, "utf-8");
    } catch (err) {
      console.error(`[detail] Failed to read markdown at ${job.markdownPath}:`, err);
      markdown = null;
    }
  }

  // Find regulation by matching job.source against regulation.regulationName
  let regulation = null;
  if (job.source) {
    const regulationRepo = AppDataSource.getRepository(Regulation);
    regulation = await regulationRepo.findOne({
      where: { regulationName: job.source },
    });
  }

  // Provisions for this regulation
  const provisions = regulation ? await listProvisions(regulation.id) : [];

  // Scores for this regulation
  const scores = regulation ? await listRegulationScores(regulation.id) : [];

  res.json({
    job,
    markdown,
    regulation,
    provisions,
    scores,
  });
});

// ── Job management ──
app.get("/api/ingest/jobs", async (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
  const jobs = await listJobs(sessionId);
  res.json({ count: jobs.length, jobs });
});

// ── Session management (pipeline runs + their docs) ──
app.get("/api/sessions", async (_req, res) => {
  const sessions = await listSessions();
  res.json({ count: sessions.length, sessions });
});

app.get("/api/sessions/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "session id is required." });
    return;
  }
  const session = await getSession(id);
  if (!session) {
    res.status(404).json({ error: `Session ${id} not found.` });
    return;
  }
  const [documents, jobs] = await Promise.all([
    listSessionDocuments(id),
    listJobs(id),
  ]);
  res.json({ session, documents, jobs });
});

// ── Single job lookup (frontend polls this to reflect ingest progress) ──
// Reads the local `jobs` table, which is kept current by the ingest callback
// below. Unlike GET /api/ingest/status/:jobId (which round-trips to server-2),
// this is a cheap DB read the UI can poll frequently.
app.get("/api/ingest/job/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) {
    res.status(400).json({ error: "jobId is required." });
    return;
  }
  const job = await getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found.` });
    return;
  }
  res.json({ job });
});

// ── Ingest callback (from MCP server) ──
app.post("/api/ingest/callback", async (req, res) => {
  try {
    const payload = req.body as CallbackPayload;

    // Validate required fields
    if (!payload.job_id || !payload.status) {
      res.status(400).json({
        error: "Missing required fields: job_id and status are required",
      });
      return;
    }

    // Update job in database
    const job = await updateJobFromCallback(payload);

    console.log(`[callback] Job ${job.jobId} updated: ${job.status} (${job.pagesDone}/${job.pagesTotal} pages)`);

    // ── Auto-extract provisions once ingestion has produced markdown ──
    // Fire-and-forget so the callback responds immediately; the extraction
    // reads the exported markdown, forces an emit_provisions call, and persists
    // to the regulations + provisions tables. Only runs on done/partial with a
    // markdown path present.
    if ((job.status === "done" || job.status === "partial") && job.markdownPath) {
      const doc = await getSessionDocumentByJob(job.jobId);
      // Country from the session document; fall back to "Unknown" if unlinked.
      const country = doc
        ? (await getSession(doc.sessionId))?.country ?? "Unknown"
        : "Unknown";
      const source = job.source || doc?.url || job.markdownPath;
      const url = doc?.url ?? null;
      const conversationId = doc?.sessionId ?? payload.session_id ?? null;

      void autoExtractProvisions({
        markdownPath: job.markdownPath,
        country,
        source,
        url,
        conversationId,
      })
        .then(async (r) => {
          if (r.ok) {
            console.log(`[auto-extract] Job ${job.jobId}: stored ${r.provisionCount} provision(s) (regulation ${r.regulationId})`);

            // ── Chain: classify + score the regulation on unescap-server-3 ──
            // Uses the ChromaDB doc_id (from ingestion) as the scoring input and
            // persists the per-indicator results to the regulation_scores table,
            // linked to the Regulation registry row we just recorded.
            if (!job.docId) {
              console.warn(`[classify-score] Job ${job.jobId}: skipped — no doc_id on job`);
              return;
            }
            try {
              const s = await classifyAndScoreRegulation({
                docId: job.docId,
                regulationId: r.regulationId ?? null,
                conversationId,
                economy: country,
              });
              if (s.ok) {
                console.log(`[classify-score] Job ${job.jobId}: stored ${s.indicatorCount} indicator score(s) (doc ${job.docId})`);
              } else {
                console.warn(`[classify-score] Job ${job.jobId}: skipped — ${s.error}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[classify-score] Job ${job.jobId}: unexpected error — ${msg}`);
            }
          } else {
            console.warn(`[auto-extract] Job ${job.jobId}: skipped — ${r.error}`);
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[auto-extract] Job ${job.jobId}: unexpected error — ${msg}`);
        });
    }

    res.json({
      success: true,
      job_id: job.jobId,
      status: job.status,
      updated_at: job.updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[callback] Error: ${message}`);
    res.status(500).json({
      error: message,
    });
  }
});

// ── Zone-1 retrieval pipeline (search → process → download) ──
// Iterative, agent-style loop that streams live progress via SSE so the client
// can show the agent reasoning + searching in real time (thinking → translate →
// search → retrieve). The terminal `zone1.done` event carries the full result.
app.post("/api/zone1/run", async (req, res) => {
  const body = req.body as { query?: unknown; country?: unknown; max_docs?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const country = typeof body.country === "string" ? body.country.trim() : "";

  if (!query || !country) {
    res.status(400).json({ error: "Both `query` and `country` are required." });
    return;
  }

  const maxDocs =
    typeof body.max_docs === "number" && body.max_docs > 0
      ? Math.min(Math.floor(body.max_docs), 20)
      : 8;

  // ── Create the session up front so a session id exists for the whole run ──
  // The id doubles as the chat conversation_id and the ingest job session_id.
  const sessionId = uuidv4();
  const title = `${query} · ${country}`.slice(0, 255);
  try {
    await createSession({ id: sessionId, title, query, country });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zone1] Failed to create session: ${message}`);
    res.status(500).json({ error: message });
    return;
  }

  // ── SSE setup ──
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Tell the client which session this run belongs to (first event).
  send("zone1.session", { sessionId, title, query, country });

  try {
    const result = await runZone1(query, country, maxDocs, (ev) => {
      // Namespace the SSE event so the frontend parser can route it.
      send(`zone1.${ev.type}`, ev);
    });

    // Persist the run outcome + retrieved documents onto the session.
    const documents: SessionDocumentInput[] = result.documents.map((d) => ({
      docKey: d.id,
      title: d.title,
      url: d.url,
      domain: d.domain,
      description: d.description,
      relevanceScore: d.relevanceScore,
      status: d.status,
      filePath: d.filePath,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      inputType: d.inputType,
      error: d.error,
    }));
    await finalizeSession(sessionId, {
      status: "completed",
      searchCount: result.searchCount,
      iterations: result.iterations,
      attempted: result.attempted,
      documents,
    });

    // `zone1.done` is also emitted by the progress callback; this is a no-op
    // safety net if the callback path ever changes. Include the session id.
    send("zone1.result", { ...result, sessionId });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zone1] Error: ${message}`);
    try {
      await finalizeSession(sessionId, { status: "failed", error: message });
    } catch {
      /* best-effort */
    }
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      send("zone1.error", { error: message });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});

// ── Ingest a selected retrieved document (server-2) ──
app.post("/api/ingest", async (req, res) => {
  try {
    const body = req.body as {
      file_path?: unknown;
      source?: unknown;
      input_type?: unknown;
      collection?: unknown;
      session_id?: unknown;
    };

    const filePath = typeof body.file_path === "string" ? body.file_path : "";
    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : filePath;
    const inputType = body.input_type === "html_file" ? "html_file" : "pdf_file";

    if (!filePath) {
      res.status(400).json({ error: "`file_path` is required." });
      return;
    }

    // Give the ingest server our callback endpoint so job status flows back
    // into the jobs table (see POST /api/ingest/callback).
    const callbackUrl = `http://localhost:${env.PORT}/api/ingest/callback`;

    const result = await ingestDocument({
      filePath,
      source,
      inputType,
      collection: typeof body.collection === "string" ? body.collection : undefined,
      sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
      callbackUrl,
    });

    // If this ingest belongs to a session, link the returned job to the
    // session document (matched by file path) so a reloaded session can poll
    // its ingest status.
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (sessionId) {
      const jobId = extractJobId(result);
      if (jobId) {
        try {
          await linkIngestJob(sessionId, filePath, jobId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ingest] Failed to link job ${jobId} to session ${sessionId}: ${message}`);
        }
      }
    }

    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] Error: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ── Poll an ingest job's status directly from server-2 ──
app.get("/api/ingest/status/:jobId", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    if (!jobId) {
      res.status(400).json({ error: "jobId is required." });
      return;
    }
    const result = await getIngestStatus(jobId);
    res.json({ job_id: jobId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest-status] Error: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ── OpenAI-compatible chat completions ──
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body as ChatCompletionRequest;

  // Validate request
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        code: 400,
      },
    });
    return;
  }

  // Only streaming mode is supported (this is an agentic SSE backend)
  if (body.stream === false) {
    res.status(400).json({
      error: {
        message:
          "Non-streaming mode is not supported. Set stream: true or omit the field.",
        type: "invalid_request_error",
        code: 400,
      },
    });
    return;
  }

  try {
    await runAgentLoop(body.messages, body.conversation_id, res);
  } catch (err) {
    // If headers haven't been sent yet, return a JSON error
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: 500,
        },
      });
    }
  }
});

// ── Error handler ──
app.use(errorHandler);

// ── Bootstrap: connect MCP servers → discover tools → start Express ──
async function bootstrap(): Promise<void> {
  try {
    // 0. Initialize TypeORM database connection
    await initializeDatabase();

    // 1. Connect to all MCP servers and discover tools
    const totalTools = await connectAllMcpServers();

    // 2. Register discovered tools in the executor registry
    registerDiscoveredTools();

    // 3. Build the agent skill from discovered tools
    const skill = buildSkill();

    // 4. Start Express server
    const server = app.listen(env.PORT, () => {
      const serverNames = getConnectionStatus()
        .map((s) => `${s.name} (${s.toolCount} tools)`)
        .join(", ");

      console.log(`
╔══════════════════════════════════════════════════════╗
║            UNESCAP Orchestra Agent                   ║
╠══════════════════════════════════════════════════════╣
║  Server:  http://localhost:${String(env.PORT).padEnd(27)}║
║  Model:   ${env.OPENAI_MODEL.padEnd(42)}║
║  Skill:   ${skill.name.padEnd(42)}║
║  Tools:   ${String(totalTools).padEnd(42)}║
║  MCP:     ${serverNames.padEnd(42)}║
╠══════════════════════════════════════════════════════╣
║  POST /v1/chat/completions    (SSE streaming)        ║
║  POST /api/zone1/run          (Zone-1 retrieval)     ║
║  POST /api/ingest             (Ingest selected doc)  ║
║  GET  /api/ingest/status/:id  (Ingest job status)    ║
║  GET  /api/ingest/job/:id     (Local job poll)       ║
║  POST /api/ingest/callback    (MCP job updates)      ║
║  GET  /api/ingest/jobs        (List ingest jobs)     ║
║  GET  /api/sessions           (List pipeline runs)   ║
║  GET  /api/sessions/:id       (Session + docs+jobs)  ║
║  GET  /regulations            (Regulation registry)  ║
║  GET  /health                                        ║
╚══════════════════════════════════════════════════════╝
      `);
    });

    // ── Graceful shutdown ──
    async function shutdown(signal: string): Promise<void> {
      console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);
      server.close();
      await closeDatabase();
      console.log("[shutdown] Done.");
      process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Bootstrap failed: ${msg}\n`);
    console.error("Ensure all MCP servers are running and MCP_SERVERS is configured correctly.");
    process.exit(1);
  }
}

bootstrap();
