export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEventType = 'agent.thinking' | 'agent.tool_call' | 'agent.tool_result' | 'agent.content' | 'agent.error' | 'agent.done';

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface McpServerStatus {
  name: string;
  url: string;
  sessionId: string | null;
  toolCount: number;
  tools: string[];
}

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
  mcp_servers: McpServerStatus[];
}

export type FeedItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'event'; event: AgentEvent };

// ── Zone-1 pipeline types ──

export type Country = 'Malaysia' | 'Singapore' | 'Australia';

export interface RetrievedDocument {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  description: string | null;
  relevanceScore: number | null;
  isDocumentFile: boolean;
  status: 'downloaded' | 'failed';
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  inputType: 'pdf_file' | 'html_file' | null;
  error: string | null;
}

export interface Zone1RunResult {
  query: string;
  country: string;
  searchCount: number;
  attempted: number;
  documents: RetrievedDocument[];
  iterations: number;
  /** Session this run belongs to (present once the run is persisted). */
  sessionId?: string;
}

/** A pipeline session summary (one Zone-1 run). */
export interface Session {
  id: string;
  title: string;
  query: string;
  country: string;
  status: 'running' | 'completed' | 'failed';
  searchCount: number;
  iterations: number;
  attempted: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted retrieved document belonging to a session. */
export interface SessionDocumentRow {
  id: string;
  sessionId: string;
  docKey: string;
  title: string;
  url: string;
  domain: string | null;
  description: string | null;
  relevanceScore: number | null;
  status: 'downloaded' | 'failed';
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  inputType: 'pdf_file' | 'html_file' | null;
  error: string | null;
  ingestJobId: string | null;
  createdAt: string;
}

/**
 * Live progress events streamed by the Zone-1 iterative loop (mirrors the
 * server-side Zone1ProgressEvent union in src/pipeline/zone1.ts).
 */
export type Zone1ProgressEvent =
  | { type: 'start'; query: string; country: string; maxIterations: number }
  | { type: 'thinking'; iteration: number; thought: string }
  | { type: 'tool'; iteration: number; tool: string; phase: 'call' | 'success' | 'error'; detail: string }
  | { type: 'retrieve'; iteration: number; document: RetrievedDocument }
  | { type: 'iteration_done'; iteration: number; downloadedTotal: number }
  | { type: 'done'; result: Zone1RunResult };

/** A rendered entry in the Zone-1 live activity feed. */
export interface Zone1FeedItem {
  id: string;
  event: Zone1ProgressEvent;
}

/** An ingest job row as stored in the orchestra `jobs` table. */
export interface Job {
  jobId: string;
  sessionId: string | null;
  status: 'pending' | 'processing' | 'done' | 'partial' | 'failed';
  source: string;
  version: number;
  docId: string | null;
  collection: string | null;
  pagesTotal: number | null;
  pagesDone: number;
  pagesViaVlm: number;
  pagesViaPdfplumber: number;
  pagesFailed: number;
  durationSec: number | null;
  markdownPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-document ingest state tracked in the UI.
 *
 * `submitted` means the ingest request was accepted and a job_id returned;
 * from there the UI polls the job and advances through `processing` →
 * `done`/`partial`/`failed` as the ingest callback updates the DB.
 */
export interface IngestState {
  status: 'idle' | 'submitting' | 'submitted' | 'processing' | 'done' | 'partial' | 'failed' | 'error';
  jobId: string | null;
  message: string | null;
  /** Latest job row from polling (present once the job exists in the DB). */
  job?: Job | null;
}

/** Provision (extracted regulatory clause). */
export interface Provision {
  id: string;
  regulationId: string;
  provisionText: string;
  lawNumber: string;
  rationale: string | null;
  coverageType: string;
  coverageSector: string | null;
  address: string | null;
  pillar: string | null;
  indicator: string | null;
  confidence: number | null;
  flagForReview: boolean;
  createdAt: string;
}

/** Regulation entity. */
export interface Regulation {
  id: string;
  country: string;
  regulationName: string;
  englishName: string;
  lawNumber: string | null;
  summary: string | null;
  mdPath: string | null;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Regulation score (one per indicator). */
export interface RegulationScore {
  id: string;
  regulationId: string | null;
  docId: string | null;
  indicatorId: string;
  indicatorName: string | null;
  pillar: string | null;
  score: number | null;
  confidence: number | null;
  justification: string | null;
  keyEvidence: string[];
  isValid: boolean;
  validationIssues: string[];
  referenceScore: number | null;
  referenceMatch: boolean | null;
  summary: string | null;
  createdAt: string;
}

/** Document detail (for modal view). */
export interface DocumentDetail {
  job: Job;
  markdown: string | null;
  regulation: Regulation | null;
  provisions: Provision[];
  scores: RegulationScore[];
}

