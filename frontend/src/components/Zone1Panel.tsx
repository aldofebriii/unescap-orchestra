import { useCallback, useRef, useState } from 'react';
import { runZone1 } from '../api';
import type {
  Country,
  Zone1RunResult,
  Zone1FeedItem,
  Zone1ProgressEvent,
} from '../types';
import DocumentIngestList from './DocumentIngestList';
import styles from './Zone1Panel.module.css';

const COUNTRIES: Country[] = ['Malaysia', 'Singapore', 'Australia'];

let feedIdCounter = 0;
const nextFeedId = () => `feed-${++feedIdCounter}`;

/**
 * Live Zone-1 retrieval panel. Runs a new pipeline session (search → download),
 * streams agent activity, then hands the retrieved documents to the shared
 * {@link DocumentIngestList} for selection + ingest.
 *
 * `onSessionCreated` fires as soon as the backend assigns a session id so the
 * parent can refresh the session list; `runSessionId` is threaded into ingest
 * calls so jobs link back to this run.
 */
export default function Zone1Panel({
  onSessionCreated,
}: {
  onSessionCreated?: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState<Country>('Malaysia');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<Zone1RunResult | null>(null);
  const [feed, setFeed] = useState<Zone1FeedItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const handleRun = useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;

    setRunning(true);
    setRunError(null);
    setResult(null);
    setFeed([]);
    setSessionId(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await runZone1(
        q,
        country,
        (event) => {
          if (event.type !== 'done') {
            setFeed((prev) => [...prev, { id: nextFeedId(), event }]);
          }
        },
        controller.signal,
        (sid) => {
          setSessionId(sid);
          onSessionCreated?.(sid);
        },
      );
      setResult(res);
      if (res.sessionId) setSessionId(res.sessionId);
      // Refresh the session list now that the run persisted its documents.
      onSessionCreated?.(res.sessionId ?? sessionId ?? '');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setRunError('Cancelled.');
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [query, country, running, onSessionCreated, sessionId]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const downloadedCount = (result?.documents ?? []).filter((d) => d.status === 'downloaded').length;

  return (
    <div className={styles.panel}>
      {/* ── Controls ── */}
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.label}>Query</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Personal Data Protection Act"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRun(); }}
            disabled={running}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Country</label>
          <div className={styles.countries}>
            {COUNTRIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`${styles.countryChip} ${country === c ? styles.countryActive : ''}`}
                onClick={() => setCountry(c)}
                disabled={running}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.actions}>
          {running ? (
            <button type="button" className={styles.stopBtn} onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={styles.runBtn}
              onClick={handleRun}
              disabled={!query.trim()}
            >
              Run Zone-1
            </button>
          )}
        </div>
      </div>

      <div className={styles.hint}>
        Zone-1 searches government sources, resolves each hit, and downloads the documents it can
        retrieve. Each run becomes a session with its own documents, ingest jobs, and chat.
      </div>

      {/* ── Live activity feed ── */}
      {feed.length > 0 && (
        <div className={styles.feed}>
          <div className={styles.feedHeader}>
            {running && <span className={styles.spinner} />}
            Agent activity{running ? '…' : ''}
          </div>
          {feed.map((item) => (
            <FeedRow key={item.id} event={item.event} />
          ))}
        </div>
      )}

      {running && feed.length === 0 && (
        <div className={styles.running}>
          <span className={styles.spinner} />
          Searching &amp; retrieving documents for <strong>{country}</strong>…
        </div>
      )}

      {runError && <div className={styles.error}>{runError}</div>}

      {/* ── Results ── */}
      {result && !running && (
        <>
          <div className={styles.summary}>
            {result.iterations} iteration(s) · searched <strong>{result.searchCount}</strong>{' '}
            result(s) · downloaded <strong>{downloadedCount}</strong> document(s)
          </div>

          <DocumentIngestList documents={result.documents} sessionId={sessionId} />
        </>
      )}
    </div>
  );
}

/** One row in the live agent activity feed. */
function FeedRow({ event }: { event: Zone1ProgressEvent }) {
  let icon = '';
  let cls = '';
  let iter: number | null = null;
  let body: React.ReactNode = null;

  switch (event.type) {
    case 'start':
      icon = '🚀';
      body = (
        <>
          <span className={styles.feedLabel}>Starting Zone-1</span> — “{event.query}” in{' '}
          {event.country} (up to {event.maxIterations} iterations)
        </>
      );
      break;
    case 'thinking':
      icon = '🧠';
      cls = styles.feedThinking;
      iter = event.iteration;
      body = <span>{event.thought}</span>;
      break;
    case 'tool': {
      const t = event.tool;
      if (event.phase === 'call') {
        icon = /search/i.test(t) ? '🔎' : /download/i.test(t) ? '⬇️' : '🔧';
        cls = styles.feedSearch;
        body = (
          <>
            <span className={styles.feedLabel}>{t}</span>{' '}
            <span className={styles.feedNative}>{event.detail}</span>
          </>
        );
      } else if (event.phase === 'error') {
        icon = '⚠️';
        cls = styles.feedRetrieveFail;
        body = (
          <>
            <span className={styles.feedLabel}>{t} failed</span> — {event.detail}
          </>
        );
      } else {
        icon = '✓';
        body = (
          <>
            {t} <span className={styles.feedNative}>{event.detail}</span>
          </>
        );
      }
      iter = event.iteration;
      break;
    }
    case 'retrieve': {
      const ok = event.document.status === 'downloaded';
      icon = ok ? '📄' : '⚠️';
      cls = ok ? styles.feedRetrieveOk : styles.feedRetrieveFail;
      iter = event.iteration;
      body = ok ? (
        <>
          <span className={styles.feedLabel}>Retrieved</span> {event.document.title}
        </>
      ) : (
        <>
          <span className={styles.feedLabel}>Failed</span> {event.document.title} —{' '}
          {event.document.error ?? 'unknown error'}
        </>
      );
      break;
    }
    case 'iteration_done':
      icon = '✓';
      iter = event.iteration;
      body = (
        <>
          Iteration {event.iteration} done — {event.downloadedTotal} document(s) so far
        </>
      );
      break;
    default:
      return null;
  }

  return (
    <div className={`${styles.feedItem} ${cls}`}>
      <span className={styles.feedIcon}>{icon}</span>
      <div className={styles.feedBody}>{body}</div>
      {iter != null && <span className={styles.feedIter}>#{iter}</span>}
    </div>
  );
}
