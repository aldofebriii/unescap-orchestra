import type { Session } from '../types';
import styles from './SessionSidebar.module.css';

/**
 * Left rail listing pipeline sessions. Selecting one loads its detail view; the
 * "New run" button returns to the live Zone-1 panel.
 */
export default function SessionSidebar({
  sessions,
  activeId,
  onSelect,
  onNewRun,
  loading,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewRun: () => void;
  loading: boolean;
}) {
  return (
    <aside className={styles.sidebar}>
      <button type="button" className={styles.newBtn} onClick={onNewRun}>
        + New run
      </button>

      <div className={styles.listHeader}>Sessions</div>

      <div className={styles.list}>
        {loading && sessions.length === 0 && (
          <div className={styles.empty}>Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className={styles.empty}>No runs yet. Start one with “New run”.</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`${styles.item} ${activeId === s.id ? styles.itemActive : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.query}
          >
            <div className={styles.itemTitle}>{s.query}</div>
            <div className={styles.itemMeta}>
              <span className={styles.country}>{s.country}</span>
              <span className={`${styles.status} ${styles['status_' + s.status]}`}>{s.status}</span>
            </div>
            <div className={styles.itemDate}>{new Date(s.createdAt).toLocaleString()}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
