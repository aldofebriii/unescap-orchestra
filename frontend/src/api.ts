import type { HealthResponse, Zone1RunResult, Zone1ProgressEvent, Job, Session, SessionDocumentRow } from './types';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function sendChatRequest(
  userContent: string,
  conversationId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const body: Record<string, unknown> = {
    stream: true,
    messages: [{ role: 'user', content: userContent }],
  };
  if (conversationId) body.conversation_id = conversationId;

  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    throw new Error((err as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
  }

  return res;
}

// ── Zone-1 pipeline API ──

/**
 * Run the Zone-1 iterative retrieval loop, streaming live progress via SSE.
 *
 * Each `zone1.*` event is decoded and forwarded to `onProgress` so the UI can
 * show the agent thinking → searching → retrieving in real time. Resolves with
 * the final {@link Zone1RunResult} carried by the terminal `zone1.done` (or
 * `zone1.result`) event.
 */
export async function runZone1(
  query: string,
  country: string,
  onProgress: (event: Zone1ProgressEvent) => void,
  signal?: AbortSignal,
  onSession?: (sessionId: string) => void,
): Promise<Zone1RunResult> {
  const res = await fetch('/api/zone1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, country }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingEventType: string | null = null;
  let finalResult: Zone1RunResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingEventType = null;
        continue;
      }

      if (trimmed.startsWith('event: ')) {
        pendingEventType = trimmed.slice(7).trim();
        continue;
      }

      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          pendingEventType = null;
          continue;
        }

        try {
          const data = JSON.parse(dataStr);
          if (pendingEventType === 'zone1.error') {
            throw new Error(String((data as { error?: unknown }).error ?? 'Zone-1 run failed.'));
          }
          if (pendingEventType === 'zone1.session') {
            const s = data as { sessionId?: string };
            if (s.sessionId) onSession?.(s.sessionId);
          } else if (pendingEventType === 'zone1.result') {
            finalResult = data as Zone1RunResult;
          } else if (pendingEventType?.startsWith('zone1.')) {
            const event = data as Zone1ProgressEvent;
            if (event.type === 'done') finalResult = event.result;
            onProgress(event);
          }
        } catch (err) {
          // Re-throw explicit zone1.error; ignore unparseable keep-alive lines.
          if (pendingEventType === 'zone1.error') throw err;
        }
        pendingEventType = null;
      }
    }
  }

  if (!finalResult) throw new Error('Zone-1 run ended without a result.');
  return finalResult;
}

/** Ingest a selected retrieved document into the vector store (server-2). */
export async function ingestDocument(params: {
  filePath: string;
  source: string;
  inputType: 'pdf_file' | 'html_file';
  sessionId?: string;
}): Promise<{ success: boolean; result: unknown }> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_path: params.filePath,
      source: params.source,
      input_type: params.inputType,
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch a single ingest job's current state from the orchestra's local `jobs`
 * table (kept up to date by the MCP ingest callback). Returns null if the job
 * doesn't exist yet — e.g. the callback hasn't fired for the first time.
 */
export async function fetchJob(jobId: string): Promise<Job | null> {
  const res = await fetch(`/api/ingest/job/${encodeURIComponent(jobId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { job: Job };
  return data.job;
}

/** Fetch document detail (markdown, provisions, scores) by job ID. */
export async function fetchDocumentDetail(jobId: string): Promise<import('./types').DocumentDetail> {
  const res = await fetch(`/api/documents/${encodeURIComponent(jobId)}/detail`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Session API ──

/** List all pipeline sessions, most recent first. */
export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  const data = (await res.json()) as { sessions: Session[] };
  return data.sessions;
}

/** Fetch a single session with its documents and ingest jobs. */
export async function fetchSession(id: string): Promise<{
  session: Session;
  documents: SessionDocumentRow[];
  jobs: Job[];
}> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

