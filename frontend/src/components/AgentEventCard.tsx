import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent } from '../types';
import styles from './AgentEventCard.module.css';

export default function AgentEventCard({ event }: { event: AgentEvent }) {
  const { type, data } = event;
  const [expanded, setExpanded] = useState(false);

  // ── Intermediate LLM reasoning text ──
  if (type === 'agent.content') {
    const text = String(data.content ?? '');
    if (!text.trim()) return null;
    return (
    <div className={styles.wrapper}>
      <div className={`${styles.card} ${styles.reasoning}`}>
        <div className={styles.reasoningHeader}>
          <span className={styles.icon}>💭</span>
          <button
            className={styles.reasoningToggle}
            onClick={() => setExpanded((v) => !v)}
          >
            <span className={styles.label}>Reasoning</span>
            <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
          </button>
        </div>
        {expanded && (
          <div className={styles.reasoningContent}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
    );
  }

  // ── Done badge ──
  if (type === 'agent.done') {
    return (
      <div className={styles.wrapper}>
        <div className={`${styles.card} ${styles.done}`}>
          <span className={styles.icon}>✅</span>
          <div className={styles.body}>
            <div className={styles.label}>
              Done — {String(data.iterations ?? 0)} iteration{Number(data.iterations) !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Other events ──
  let cardClass = '', icon = '', label = '', detail = '';

  switch (type) {
    case 'agent.thinking':
      cardClass = styles.thinking; icon = '🧠';
      label = `Thinking — iteration ${data.iteration}`;
      detail = `${data.message_count} messages in context`;
      break;
    case 'agent.tool_call':
      cardClass = styles.toolCall; icon = '🔧';
      label = String(data.tool ?? 'tool');
      detail = JSON.stringify(data.arguments ?? {}).slice(0, 300);
      break;
    case 'agent.tool_result':
      cardClass = data.status === 'error' ? styles.toolError : styles.toolResult;
      icon = data.status === 'error' ? '❌' : '✅';
      label = `${data.tool} — ${data.status} (${data.duration_ms}ms)`;
      detail = typeof data.result_preview === 'string' ? data.result_preview.slice(0, 300) : '';
      break;
    case 'agent.error':
      cardClass = styles.toolError; icon = '⚠️'; label = 'Error';
      detail = String(data.error ?? '');
      break;
    default: return null;
  }

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.card} ${cardClass}`}>
        <span className={styles.icon}>{icon}</span>
        <div className={styles.body}>
          <div className={styles.label}>{label}</div>
          {detail && <div className={styles.detail}>{detail}</div>}
        </div>
      </div>
    </div>
  );
}
