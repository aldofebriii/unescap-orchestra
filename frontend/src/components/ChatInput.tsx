import { useRef, useCallback, type KeyboardEvent } from 'react';
import styles from './ChatInput.module.css';

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}

export default function ChatInput({ onSend, onStop, isStreaming }: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = ref.current?.value.trim();
    if (!text || isStreaming) return;
    onSend(text);
    if (ref.current) { ref.current.value = ''; ref.current.style.height = 'auto'; }
  }, [onSend, isStreaming]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const autoResize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className={styles.inputArea}>
      <div className={styles.wrapper}>
        <div className={styles.box}>
          <textarea
            ref={ref}
            className={styles.textarea}
            placeholder={isStreaming ? 'AI is thinking…' : 'Ask about legal documents across Asia-Pacific…'}
            rows={1}
            onKeyDown={handleKeyDown}
            onInput={autoResize}
            disabled={isStreaming}
          />
        </div>

        {isStreaming ? (
          <button
            className={`${styles.actionBtn} ${styles.stopBtn}`}
            onClick={onStop}
            title="Stop generation"
          >
            ■
          </button>
        ) : (
          <button
            className={`${styles.actionBtn} ${styles.sendBtn}`}
            onClick={handleSend}
            disabled={isStreaming}
            title="Send message"
          >
            ▶
          </button>
        )}
      </div>
    </div>
  );
}
