import { useCallback, useEffect, useMemo, useState } from 'react';
import { ingestDocument, fetchJob } from '../api';
import type { RetrievedDocument, IngestState, Job } from '../types';
import DocumentDetailModal from './DocumentDetailModal';
import styles from './Zone1Panel.module.css';

/** How often to poll the job endpoint while an ingest is in flight (ms). */
const JOB_POLL_INTERVAL_MS = 2000;
/** Job statuses that mean the ingest has stopped progressing. */
const TERMINAL_JOB_STATUSES = new Set(['done', 'partial', 'failed']);

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Selectable list of retrieved documents with ingest + live status polling.
 *
 * Shared by the live Zone-1 run panel and the saved-session detail view. When
 * a `sessionId` is provided it is threaded into ingest calls (so jobs link back
 * to the session) and used implicitly by the poll. `initialIngest` seeds the
 * per-document ingest state when reloading a saved session (from its jobs).
 */
export default function DocumentIngestList({
  documents,
  sessionId,
  initialIngest,
}: {
  documents: RetrievedDocument[];
  sessionId: string | null;
  initialIngest?: Record<string, IngestState>;
}) {
  const downloaded = useMemo(
    () => documents.filter((d) => d.status === 'downloaded'),
    [documents],
  );
  const failed = useMemo(
    () => documents.filter((d) => d.status === 'failed'),
    [documents],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ingestByDoc, setIngestByDoc] = useState<Record<string, IngestState>>(initialIngest ?? {});
  const [ingesting, setIngesting] = useState(false);
  const [detailModalDoc, setDetailModalDoc] = useState<{jobId: string; title: string} | null>(null);

  // Auto-select downloaded docs that haven't been ingested yet.
  useEffect(() => {
    setSelected(
      new Set(
        downloaded
          .filter((d) => {
            const st = ingestByDoc[d.id];
            return !st || st.status === 'idle';
          })
          .map((d) => d.id),
      ),
    );
    if (initialIngest) setIngestByDoc(initialIngest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, ingestByDoc]);

  // Live ingest-status polling for any job not yet terminal.
  useEffect(() => {
    const active = Object.entries(ingestByDoc).filter(
      ([, st]) => st.jobId && !TERMINAL_JOB_STATUSES.has(st.status),
    );
    if (active.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      await Promise.all(
        active.map(async ([docId, st]) => {
          if (!st.jobId) return;
          try {
            const job = await fetchJob(st.jobId);
            if (cancelled || !job) return;
            setIngestByDoc((prev) => {
              const cur = prev[docId];
              if (!cur || cur.jobId !== st.jobId) return prev;
              return { ...prev, [docId]: mergeJobIntoIngest(cur, job) };
            });
          } catch {
            /* transient — retry next tick */
          }
        }),
      );
    };
    void poll();
    const timer = setInterval(poll, JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ingestByDoc]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleIngest = useCallback(async () => {
    if (ingesting) return;
    const docs = downloaded.filter((d) => selected.has(d.id) && d.filePath);
    if (docs.length === 0) return;

    setIngesting(true);
    setIngestByDoc((prev) => {
      const next = { ...prev };
      for (const d of docs) next[d.id] = { status: 'submitting', jobId: null, message: null };
      return next;
    });

    for (const d of docs) {
      try {
        const resp = await ingestDocument({
          filePath: d.filePath!,
          source: d.title || d.url,
          inputType: d.inputType ?? 'pdf_file',
          sessionId: sessionId ?? undefined,
        });
        const jobId = extractJobId(resp.result);
        setIngestByDoc((prev) => ({
          ...prev,
          [d.id]: {
            status: 'submitted',
            jobId,
            message: jobId ? 'Ingest started — waiting for processing…' : 'Ingest started',
          },
        }));
      } catch (err) {
        setIngestByDoc((prev) => ({
          ...prev,
          [d.id]: {
            status: 'error',
            jobId: null,
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    }
    setIngesting(false);
  }, [downloaded, selected, ingesting, sessionId]);
  return (
    <>
      <div className={styles.docIngestHeader}>
        <div className={styles.docCounts}>
          <span className={styles.countOk}>{downloaded.length} downloaded</span>
          {failed.length > 0 && <span className={styles.countFail}>{failed.length} failed</span>}
        </div>
        {downloaded.length > 0 && (
          <button
            type="button"
            className={styles.btnIngest}
            onClick={handleIngest}
            disabled={ingesting || selected.size === 0}
          >
            {ingesting
              ? 'Starting ingests…'
              : `Ingest${selected.size === 1 ? '' : ` ${selected.size}`}`}
          </button>
        )}
      </div>

      <div className={styles.list}>
        {downloaded.map((doc) => (
          <DocumentCard
            key={doc.id}
            doc={doc}
            checked={selected.has(doc.id)}
            onToggle={() => toggle(doc.id)}
            ingest={ingestByDoc[doc.id]}
            onShowDetail={(jobId) => setDetailModalDoc({jobId, title: doc.title})}
          />
        ))}

        {failed.length > 0 && (
          <div className={styles.failedSection}>
            <div className={styles.failedHeading}>Could not retrieve ({failed.length})</div>
            {failed.map((doc) => (
              <div key={doc.id} className={styles.failedRow}>
                <span className={styles.failedTitle} title={doc.url}>{doc.title}</span>
                <span className={styles.failedReason}>{doc.error ?? 'Unknown error'}</span>
              </div>
            ))}
          </div>
        )}

        {downloaded.length === 0 && (
          <div className={styles.empty}>
            No documents could be downloaded for this query. Try a different phrasing —
            ideally in the target country's official language.
          </div>
        )}
      </div>

      {detailModalDoc && (
        <DocumentDetailModal
          jobId={detailModalDoc.jobId}
          title={detailModalDoc.title}
          onClose={() => setDetailModalDoc(null)}
        />
      )}
    </>
  );
}

function DocumentCard({
  doc,
  checked,
  onToggle,
  ingest,
  onShowDetail,
}: {
  doc: RetrievedDocument;
  checked: boolean;
  onToggle: () => void;
  ingest?: IngestState;
  onShowDetail: (jobId: string) => void;
}) {
  const alreadyIngested = ingest && ['submitted', 'processing', 'done', 'partial'].includes(ingest.status);
  const canShowDetail = ingest?.jobId && ingest.status !== 'idle' && ingest.status !== 'submitting';

  return (
    <div className={`${styles.card} ${checked ? styles.cardChecked : ''}`}>
      <label className={styles.checkboxWrap}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={ingest?.status === 'submitting' || Boolean(alreadyIngested)}
        />
      </label>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          {canShowDetail ? (
            <button
              type="button"
              className={styles.cardTitleBtn}
              onClick={() => onShowDetail(ingest.jobId!)}
              title="View document detail (markdown, provisions, scores)"
            >
              {doc.title}
            </button>
          ) : (
            <a className={styles.cardTitle} href={doc.url} target="_blank" rel="noreferrer">
              {doc.title}
            </a>
          )}
          {doc.relevanceScore != null && (
            <span className={styles.score}>{doc.relevanceScore.toFixed(0)}</span>
          )}
        </div>

        {doc.description && <div className={styles.cardDesc}>{doc.description}</div>}

        <div className={styles.meta}>
          {doc.domain && <span className={styles.metaTag}>{doc.domain}</span>}
          {doc.inputType && <span className={styles.metaTag}>{doc.inputType === 'pdf_file' ? 'PDF' : 'HTML'}</span>}
          {doc.sizeBytes != null && <span className={styles.metaTag}>{formatBytes(doc.sizeBytes)}</span>}
          {doc.filePath && <span className={styles.metaPath} title={doc.filePath}>{doc.filePath}</span>}
        </div>

        {ingest && ingest.status !== 'idle' && (
          <div
            className={`${styles.ingestStatus} ${
              ingest.status === 'error' || ingest.status === 'failed'
                ? styles.ingestError
                : ingest.status === 'done' || ingest.status === 'partial'
                ? styles.ingestOk
                : styles.ingestPending
            }`}
          >
            {ingest.status === 'submitting' && 'Submitting ingest…'}
            {ingest.status === 'submitted' && (ingest.message ?? 'Ingest started — waiting for processing…')}
            {ingest.status === 'processing' && (ingest.message ?? 'Ingesting…')}
            {ingest.status === 'done' && (ingest.message ?? 'Ingested ✓')}
            {ingest.status === 'partial' && (ingest.message ?? 'Partially ingested')}
            {ingest.status === 'failed' && (ingest.message ?? 'Ingest failed')}
            {ingest.status === 'error' && `Ingest failed: ${ingest.message}`}
          </div>
        )}
      </div>
    </div>
  );
}

/** Fold a polled Job row into a card's ingest state. */
export function mergeJobIntoIngest(cur: IngestState, job: Job): IngestState {
  const status: IngestState['status'] =
    job.status === 'done'
      ? 'done'
      : job.status === 'partial'
      ? 'partial'
      : job.status === 'failed'
      ? 'failed'
      : job.status === 'processing' || job.status === 'pending'
      ? 'processing'
      : cur.status;
  return { ...cur, status, job, message: describeJob(job) };
}

/** One-line human-readable description of a job's current state. */
export function describeJob(job: Job): string {
  const pages = job.pagesTotal != null ? ` · ${job.pagesDone}/${job.pagesTotal} pages` : '';
  switch (job.status) {
    case 'done':
      return `Ingested${pages}${job.durationSec != null ? ` in ${job.durationSec.toFixed(1)}s` : ''}`;
    case 'partial':
      return `Partially ingested${pages}${job.pagesFailed ? ` · ${job.pagesFailed} failed` : ''}`;
    case 'failed':
      return `Ingest failed${job.error ? `: ${job.error}` : ''}`;
    case 'processing':
      return `Ingesting…${pages}`;
    case 'pending':
      return 'Queued for ingest…';
    default:
      return `Job ${job.status}`;
  }
}

/** Best-effort extraction of a job_id from the ingest_document MCP response. */
function extractJobId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const o = result as Record<string, unknown>;
  const direct = o.job_id ?? o.jobId;
  if (typeof direct === 'string') return direct;
  for (const key of ['result', 'data']) {
    const nested = o[key];
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      const id = n.job_id ?? n.jobId;
      if (typeof id === 'string') return id;
    }
  }
  return null;
}
