import { useEffect, useState } from 'react';
import { fetchHealth } from '../api';
import type { McpServerStatus } from '../types';
import type { Tab } from '../App';
import styles from './Header.module.css';

export default function Header({ tab, onTabChange }: { tab: Tab; onTabChange: (t: Tab) => void }) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetchHealth()
      .then((data) => { setServers(data.mcp_servers ?? []); setConnected(true); })
      .catch(() => setConnected(false));
  }, []);

  const toolCount = servers.reduce((s, m) => s + m.toolCount, 0);

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>U</div>
        <div>
          <div className={styles.title}>UNESCAP Orchestra</div>
          <div className={styles.subtitle}>RDTII Agent · Legal Document Research</div>
        </div>
      </div>

      <nav className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'pipeline' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('pipeline')}
        >
          Pipeline
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'chat' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('chat')}
        >
          Chat
        </button>
      </nav>

      <div className={styles.badge} style={{
        color: connected ? 'var(--green)' : 'var(--red)',
        borderColor: connected ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
        background: connected ? 'var(--green-bg)' : 'rgba(248,113,113,0.1)',
      }}>
        <span className={styles.dot} style={{ background: connected ? 'var(--green)' : 'var(--red)' }} />
        {connected ? `${servers.length} server${servers.length !== 1 ? 's' : ''} · ${toolCount} tools` : 'Disconnected'}
      </div>
    </header>
  );
}
