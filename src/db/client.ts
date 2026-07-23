/**
 * Database client — TypeORM-based persistence layer.
 *
 * Provides the same interface (createConversation, saveMessage, etc.)
 * that the agent loop uses, now backed by TypeORM entities.
 */
import "reflect-metadata";
import { AppDataSource } from "./data-source.js";
import { Conversation } from "./entities/Conversation.js";
import { Message } from "./entities/Message.js";
import { ToolExecution } from "./entities/ToolExecution.js";
import { Regulation } from "./entities/Regulation.js";
import { Provision } from "./entities/Provision.js";
import { RegulationScore } from "./entities/RegulationScore.js";
import { Job } from "./entities/Job.js";
import { Session } from "./entities/Session.js";
import { SessionDocument } from "./entities/SessionDocument.js";
import { nameSimilarity, normalizeName, NAME_MATCH_THRESHOLD } from "./similarity.js";
import { translateToEnglish } from "../agent/reasoning.js";
import type { Provision as ProvisionData } from "../agent/types.js";

/**
 * Initialize the TypeORM connection. Call once at startup.
 */
export async function initializeDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    console.log("[db] TypeORM DataSource initialized");
  }
}

/**
 * Close the database connection. Call on shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
    console.log("[db] TypeORM DataSource closed");
  }
}

// ── Repository shortcuts ──

function conversations() {
  return AppDataSource.getRepository(Conversation);
}

function messages() {
  return AppDataSource.getRepository(Message);
}

function toolExecutions() {
  return AppDataSource.getRepository(ToolExecution);
}

// ── Public helpers (same API the agent loop expects) ──

export async function createConversation(
  conversationId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const repo = conversations();
  const existing = await repo.findOneBy({ id: conversationId });
  if (existing) {
    existing.updatedAt = new Date();
    await repo.save(existing);
  } else {
    const conv = repo.create({ id: conversationId, metadata });
    await repo.save(conv);
  }
}

export async function saveMessage(
  conversationId: string,
  role: string,
  content: string | null,
  toolCalls?: unknown,
  toolCallId?: string,
  name?: string,
): Promise<void> {
  const msg = messages().create({
    conversationId,
    role,
    content,
    toolCalls: toolCalls ?? null,
    toolCallId: toolCallId ?? null,
    name: name ?? null,
  });
  await messages().save(msg);
}

export async function saveToolExecution(
  conversationId: string,
  toolName: string,
  args: unknown,
  result: unknown,
  durationMs: number,
  status: "success" | "error",
): Promise<void> {
  const exec = toolExecutions().create({
    conversationId,
    toolName,
    arguments: args as Record<string, unknown>,
    result,
    durationMs,
    status,
  });
  await toolExecutions().save(exec);
}

export async function getConversationMessages(
  conversationId: string,
): Promise<
  {
    role: string;
    content: string | null;
    tool_calls: unknown;
    tool_call_id: string | null;
    name: string | null;
  }[]
> {
  const rows = await messages().find({
    where: { conversationId },
    order: { createdAt: "ASC" },
  });

  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    tool_calls: r.toolCalls,
    tool_call_id: r.toolCallId,
    name: r.name,
  }));
}

// ── Regulation registry ──

function regulations() {
  return AppDataSource.getRepository(Regulation);
}

/**
 * Link a Job and a Regulation by setting their FK columns via raw SQL.
 *
 * TypeORM's `save()` can silently null-out FK columns when both sides of a
 * OneToOne have `@JoinColumn`, or when the relation object is undefined.
 * Using raw queries avoids all entity-lifecycle issues.
 */
async function linkJobAndRegulation(jobId: string, regulationId: string): Promise<void> {
  const qr = AppDataSource.createQueryRunner();
  try {
    await qr.query(`UPDATE regulations SET job_id = $1 WHERE id = $2`, [jobId, regulationId]);
    await qr.query(`UPDATE jobs SET regulation_id = $1 WHERE "jobId" = $2`, [regulationId, jobId]);
    console.log(`[linkJobAndRegulation] ✔ Linked job ${jobId} ↔ regulation ${regulationId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[linkJobAndRegulation] ✖ Failed to link job ${jobId} ↔ regulation ${regulationId}: ${msg}`);
  } finally {
    await qr.release();
  }
}

export interface RegulationInput {
  country: string;
  regulationName: string;
  lawNumber?: string | null;
  urls?: string[];
  summary?: string | null;
  mdPath?: string | null;
  jobId?: string | null;
}

export type RegulationOutcome =
  | { status: "created"; regulation: Regulation }
  | { status: "updated"; regulation: Regulation; addedUrls: string[]; similarity: number }
  | { status: "exists"; regulation: Regulation; similarity: number };

/**
 * Record a successfully processed regulation, de-duplicated by name similarity
 * within the same country.
 *
 * - No similar regulation for the country → create a new row.
 * - Similar regulation exists → merge in any new URLs (and backfill missing
 *   law number / summary). If no new URLs, report it as already known.
 */
export async function recordRegulation(
  input: RegulationInput,
): Promise<RegulationOutcome> {
  const repo = regulations();
  const incomingUrls = dedupeUrls(input.urls ?? []);

  console.log(`[recordRegulation] input.jobId = ${input.jobId ?? "null"}, regulationName = "${input.regulationName}"`);

  // Translate the title to English so the same law dedupes across languages.
  const englishName = await translateToEnglish(input.regulationName);

  // Scope de-dup to the country, then match on the English name.
  const candidates = await repo.findBy({ country: input.country });

  let best: Regulation | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = nameSimilarity(c.englishName, englishName);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  // Match found for this country → check/merge URLs.
  if (best && bestScore >= NAME_MATCH_THRESHOLD) {
    const existing = new Set(best.urls ?? []);
    const addedUrls = incomingUrls.filter((u) => !existing.has(u));

    best.hitCount += 1;
    if (input.lawNumber && !best.lawNumber) best.lawNumber = input.lawNumber;
    if (input.summary && !best.summary) best.summary = input.summary;
    if (input.mdPath && !best.mdPath) best.mdPath = input.mdPath;

    if (addedUrls.length > 0) {
      best.urls = [...(best.urls ?? []), ...addedUrls];
    }

    await repo.save(best);

    // Link job ↔ regulation via explicit UPDATE queries (bypasses TypeORM relation issues)
    if (input.jobId) {
      await linkJobAndRegulation(input.jobId, best.id);
    }

    if (addedUrls.length > 0) {
      return { status: "updated", regulation: best, addedUrls, similarity: bestScore };
    }
    return { status: "exists", regulation: best, similarity: bestScore };
  }

  // New regulation for this country.
  const created = repo.create({
    country: input.country,
    regulationName: input.regulationName,
    englishName,
    normalizedName: normalizeName(englishName),
    lawNumber: input.lawNumber ?? null,
    urls: incomingUrls,
    summary: input.summary ?? null,
    mdPath: input.mdPath ?? null,
    hitCount: 1,
  });
  await repo.save(created);

  // Link job ↔ regulation via explicit UPDATE queries (bypasses TypeORM relation issues)
  if (input.jobId) {
    await linkJobAndRegulation(input.jobId, created.id);
  }

  return { status: "created", regulation: created };
}

// ── Provision persistence ──

function provisionsRepo() {
  return AppDataSource.getRepository(Provision);
}

/**
 * Persist the structured provisions extracted for a regulation. Each provision
 * keeps its verbatim text, law number, rationale, and coverage
 * (horizontal/sectoral) — the fields that make a stored regulation useful for
 * the downstream classification agent and human review.
 */
export async function saveProvisionsToDb(
  regulationId: string,
  conversationId: string | null,
  provisions: ProvisionData[],
): Promise<Provision[]> {
  const repo = provisionsRepo();
  const rows = provisions.map((p) =>
    repo.create({
      regulationId,
      conversationId: conversationId ?? null,
      provisionText: p.provision_text,
      lawNumber: p.law_number,
      rationale: p.rationale ?? null,
      coverageType: p.coverage.type,
      coverageSector: p.coverage.sector ?? null,
      address: p.address ?? null,
      timeframeLastAmendment: p.timeframe_last_amendment ?? null,
      urls: dedupeUrls(p.urls ?? []),
      confidence: typeof p.confidence === "number" ? p.confidence : null,
      flagForReview: Boolean(p.flag_for_review),
      pillar: p.pillar ?? null,
      indicator: p.indicator ?? null,
    }),
  );
  return repo.save(rows);
}

/** List all provisions for a regulation. */
export async function listProvisions(regulationId: string): Promise<Provision[]> {
  return provisionsRepo().find({
    where: { regulationId },
    order: { createdAt: "ASC" },
  });
}

// ── Regulation classification / scoring persistence ──

function regulationScoresRepo() {
  return AppDataSource.getRepository(RegulationScore);
}

/** One scored indicator, as returned by classify_and_score_regulation_tool. */
export interface RegulationScoreInput {
  indicatorId: string;
  indicatorName?: string | null;
  pillar?: string | null;
  score?: number | null;
  confidence?: number | null;
  justification?: string | null;
  keyEvidence?: string[];
  isValid?: boolean;
  validationIssues?: string[];
  referenceScore?: number | null;
  referenceMatch?: boolean | null;
}

/**
 * Persist the classification + scoring results for a regulation — one row per
 * scored indicator. Replaces any prior scores for the same (regulation, doc_id)
 * so re-running classification updates rather than duplicates.
 */
export async function saveRegulationScores(
  input: {
    regulationId: string | null;
    docId: string | null;
    conversationId: string | null;
    summary: string | null;
    scores: RegulationScoreInput[];
  },
): Promise<RegulationScore[]> {
  const repo = regulationScoresRepo();

  // Idempotent re-runs: clear existing scores for this regulation / doc first.
  if (input.regulationId) {
    await repo.delete({ regulationId: input.regulationId });
  } else if (input.docId) {
    await repo.delete({ docId: input.docId });
  }

  if (input.scores.length === 0) return [];

  const rows = input.scores.map((s) =>
    repo.create({
      regulationId: input.regulationId,
      docId: input.docId,
      conversationId: input.conversationId,
      summary: input.summary,
      indicatorId: s.indicatorId,
      indicatorName: s.indicatorName ?? null,
      pillar: s.pillar ?? null,
      score: typeof s.score === "number" ? s.score : null,
      confidence: typeof s.confidence === "number" ? s.confidence : null,
      justification: s.justification ?? null,
      keyEvidence: Array.isArray(s.keyEvidence) ? s.keyEvidence : [],
      isValid: s.isValid ?? true,
      validationIssues: Array.isArray(s.validationIssues) ? s.validationIssues : [],
      referenceScore: typeof s.referenceScore === "number" ? s.referenceScore : null,
      referenceMatch: typeof s.referenceMatch === "boolean" ? s.referenceMatch : null,
    }),
  );
  return repo.save(rows);
}

/** List all persisted scores for a regulation. */
export async function listRegulationScores(regulationId: string): Promise<RegulationScore[]> {
  return regulationScoresRepo().find({
    where: { regulationId },
    order: { indicatorId: "ASC" },
  });
}

/** List all recorded regulations, optionally filtered by country. */
export async function listRegulations(country?: string): Promise<Regulation[]> {
  const repo = regulations();
  return repo.find({
    where: country ? { country } : {},
    order: { country: "ASC", regulationName: "ASC" },
  });
}

function dedupeUrls(urls: string[]): string[] {
  return [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
}

// ── Job management ──

function jobs() {
  return AppDataSource.getRepository(Job);
}

export interface CallbackPayload {
  session_id: string | null;
  job_id: string;
  status: "done" | "partial" | "failed";
  source: string;
  version: number;
  doc_id: string;
  collection: string;
  pages_total: number;
  pages_done: number;
  pages_via_vlm: number;
  pages_via_pdfplumber: number;
  pages_failed: number;
  duration_sec: number;
  markdown_path: string;
  error: string | null;
}

/**
 * Update job status from ingest callback.
 * Creates job if not exists, otherwise updates existing job.
 */
export async function updateJobFromCallback(payload: CallbackPayload): Promise<Job> {
  const repo = jobs();
  let job = await repo.findOneBy({ jobId: payload.job_id });

  if (!job) {
    job = repo.create({
      jobId: payload.job_id,
      sessionId: payload.session_id,
      status: payload.status,
      source: payload.source,
      version: payload.version,
      docId: payload.doc_id,
      collection: payload.collection,
      pagesTotal: payload.pages_total,
      pagesDone: payload.pages_done,
      pagesViaVlm: payload.pages_via_vlm,
      pagesViaPdfplumber: payload.pages_via_pdfplumber,
      pagesFailed: payload.pages_failed,
      durationSec: payload.duration_sec,
      markdownPath: payload.markdown_path,
      error: payload.error,
    });
  } else {
    // Update existing job
    job.status = payload.status;
    job.docId = payload.doc_id;
    job.collection = payload.collection;
    job.pagesTotal = payload.pages_total;
    job.pagesDone = payload.pages_done;
    job.pagesViaVlm = payload.pages_via_vlm;
    job.pagesViaPdfplumber = payload.pages_via_pdfplumber;
    job.pagesFailed = payload.pages_failed;
    job.durationSec = payload.duration_sec;
    job.markdownPath = payload.markdown_path;
    job.error = payload.error;
  }

  await repo.save(job);
  return job;
}

/** Get job by ID. */
export async function getJob(jobId: string): Promise<Job | null> {
  return jobs().findOneBy({ jobId });
}

/** List all jobs, optionally filtered by session ID. */
export async function listJobs(sessionId?: string): Promise<Job[]> {
  return jobs().find({
    where: sessionId ? { sessionId } : {},
    order: { createdAt: "DESC" },
  });
}

// ── Session management (pipeline runs) ──

function sessionsRepo() {
  return AppDataSource.getRepository(Session);
}

function sessionDocumentsRepo() {
  return AppDataSource.getRepository(SessionDocument);
}

/** Data needed to create a session at the start of a Zone-1 run. */
export interface CreateSessionInput {
  id: string;
  title: string;
  query: string;
  country: string;
}

/** A retrieved document as persisted to a session (mirrors RetrievedDocument). */
export interface SessionDocumentInput {
  docKey: string;
  title: string;
  url: string;
  domain: string | null;
  description: string | null;
  relevanceScore: number | null;
  status: "downloaded" | "failed";
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  inputType: "pdf_file" | "html_file" | null;
  error: string | null;
}

/** Create a new pipeline session (status defaults to "running"). */
export async function createSession(input: CreateSessionInput): Promise<Session> {
  const repo = sessionsRepo();
  const session = repo.create({
    id: input.id,
    title: input.title,
    query: input.query,
    country: input.country,
    status: "running",
  });
  return repo.save(session);
}

/**
 * Finalize a session after a Zone-1 run: record its status, run stats, and
 * persist the retrieved documents. Called once the run completes (or fails).
 */
export async function finalizeSession(
  sessionId: string,
  update: {
    status: "completed" | "failed";
    searchCount?: number;
    iterations?: number;
    attempted?: number;
    error?: string | null;
    documents?: SessionDocumentInput[];
  },
): Promise<void> {
  const repo = sessionsRepo();
  const session = await repo.findOneBy({ id: sessionId });
  if (session) {
    session.status = update.status;
    if (typeof update.searchCount === "number") session.searchCount = update.searchCount;
    if (typeof update.iterations === "number") session.iterations = update.iterations;
    if (typeof update.attempted === "number") session.attempted = update.attempted;
    session.error = update.error ?? null;
    await repo.save(session);
  }

  if (update.documents && update.documents.length > 0) {
    const docRepo = sessionDocumentsRepo();
    const rows = update.documents.map((d) =>
      docRepo.create({
        sessionId,
        docKey: d.docKey,
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
      }),
    );
    await docRepo.save(rows);
  }
}

/** List all sessions, most recent first. */
export async function listSessions(): Promise<Session[]> {
  return sessionsRepo().find({ order: { createdAt: "DESC" } });
}

/** Get a single session by id. */
export async function getSession(sessionId: string): Promise<Session | null> {
  return sessionsRepo().findOneBy({ id: sessionId });
}

/** List a session's retrieved documents (creation order). */
export async function listSessionDocuments(sessionId: string): Promise<SessionDocument[]> {
  return sessionDocumentsRepo().find({
    where: { sessionId },
    order: { createdAt: "ASC" },
  });
}

/** Find the session document an ingest job was created from (by job id). */
export async function getSessionDocumentByJob(jobId: string): Promise<SessionDocument | null> {
  return sessionDocumentsRepo().findOneBy({ ingestJobId: jobId });
}

/**
 * Link an ingest job to the session document it was created from, so a reloaded
 * session can poll each document's job status. Matches by session + file path.
 */
export async function linkIngestJob(
  sessionId: string,
  filePath: string,
  jobId: string,
): Promise<void> {
  const repo = sessionDocumentsRepo();
  const doc = await repo.findOneBy({ sessionId, filePath });
  if (doc) {
    doc.ingestJobId = jobId;
    await repo.save(doc);
  }
}
