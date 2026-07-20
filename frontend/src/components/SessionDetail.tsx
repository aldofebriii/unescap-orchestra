import { useEffect, useMemo, useState } from 'react';
import { fetchSession } from '../api';
import type { RetrievedDocument, IngestState, Session, SessionDocumentRow, Job } from '../types';
import DocumentIngestList, { mergeJobIntoIngest } from './DocumentIngestList';
import SessionChat from './SessionChat';
import styles from './Zone1Panel.module.css';

/** Convert a persisted session document row into the RetrievedDocument shape. */
function toRetrieved(d: SessionDocumentRow): RetrievedDocument {
  return {
    id: d.docKey,
    title: d.title,
    url: d.url,
    domain: d.domain,
    description: d.description,
    relevanceScore: d.relevanceScore,
    isDocumentFile: d.status === 'downloaded',
    status: d.status,
    filePath: d.filePath,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    inputType: d.inputType,
    error: d.error,
  };
}

/**
 * Detail view for a saved pipeline session: shows its retrieved documents (with
 * live ingest status seeded from persisted jobs) and the session's chat.
 */
export default function SessionDetail({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [docs, setDocs] = useState<SessionDocumentRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSession(sessionId)
      .then((data) => {
        if (cancelled) return;
        setSession(data.session);
        setDocs(data.documents);
        setJobs(data.jobs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const documents = useMemo(() => docs.map(toRetrieved), [docs]);

  // Seed ingest state from persisted jobs: match each document's ingestJobId to
  // its job row so the list shows the last-known status immediately, then the
  // shared list keeps polling any non-terminal jobs.
  const initialIngest = useMemo(() => {
    const jobById = new Map(jobs.map((j) => [j.jobId, j]));
    const map: Record<string, IngestState> = {};
    for (const d of docs) {
      if (!d.ingestJobId) continue;
      const job = jobById.get(d.ingestJobId);
      const base: IngestState = { status: 'submitted', jobId: d.ingestJobId, message: null };
      map[d.docKey] = job ? mergeJobIntoIngest(base, job) : base;
    }
    return map;
  }, [docs, jobs]);

  if (loading) {
    return (
      <div className={styles.panel}>
        <div className={styles.running}>
          <span className={styles.spinner} />
          Loading session…
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className={styles.panel}>
        <div className={styles.error}>{error ?? 'Session not found.'}</div>
      </div>
    );
  }

  const downloadedCount = documents.filter((d) => d.status === 'downloaded').length;

  return (
    <div className={styles.panel}>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.label}>Session</label>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            {session.query}
          </div>
          <div className={styles.meta}>
            <span className={styles.metaTag}>{session.country}</span>
            <span className={styles.metaTag}>{session.status}</span>
            <span className={styles.metaTag}>{new Date(session.createdAt).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className={styles.summary}>
        {session.iterations} iteration(s) · searched <strong>{session.searchCount}</strong>{' '}
        result(s) · downloaded <strong>{downloadedCount}</strong> document(s)
      </div>

      {session.error && <div className={styles.error}>{session.error}</div>}

      <DocumentIngestList
        documents={documents}
        sessionId={session.id}
        initialIngest={initialIngest}
      />

      {/* ── Session-scoped chat ── */}
      <SessionChat sessionId={session.id} />
    </div>
  );
}
