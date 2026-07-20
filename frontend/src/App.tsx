import { useCallback, useEffect, useState } from 'react';
import Header from './components/Header';
import ChatView from './components/ChatView';
import Zone1Panel from './components/Zone1Panel';
import SessionSidebar from './components/SessionSidebar';
import SessionDetail from './components/SessionDetail';
import { fetchSessions } from './api';
import type { Session } from './types';
import styles from './App.module.css';

export type Tab = 'pipeline' | 'chat';

export default function App() {
  const [tab, setTab] = useState<Tab>('pipeline');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  // null → show the live Zone-1 "new run" panel; otherwise a saved session id.
  const [activeSession, setActiveSession] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      setSessions(await fetchSessions());
    } catch {
      /* leave existing list on failure */
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'pipeline') void loadSessions();
  }, [tab, loadSessions]);

  const handleSessionCreated = useCallback(() => {
    // Refresh the list so the new run appears (id may still be empty mid-run).
    void loadSessions();
  }, [loadSessions]);

  return (
    <>
      <Header tab={tab} onTabChange={setTab} />
      {tab === 'pipeline' ? (
        <div className={styles.pipelineLayout}>
          <SessionSidebar
            sessions={sessions}
            activeId={activeSession}
            onSelect={setActiveSession}
            onNewRun={() => setActiveSession(null)}
            loading={loadingSessions}
          />
          <div className={styles.pipelineMain}>
            {activeSession ? (
              <SessionDetail key={activeSession} sessionId={activeSession} />
            ) : (
              <Zone1Panel onSessionCreated={handleSessionCreated} />
            )}
          </div>
        </div>
      ) : (
        <ChatView />
      )}
    </>
  );
}
