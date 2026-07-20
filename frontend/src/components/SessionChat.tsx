import { useCallback, useEffect, useRef, useState } from 'react';
import ChatMessage from './ChatMessage';
import AgentEventCard from './AgentEventCard';
import ChatInput from './ChatInput';
import ThinkingDots from './ThinkingDots';
import { sendChatRequest } from '../api';
import type { FeedItem, ChatMessage as ChatMessageType, AgentEvent } from '../types';
import styles from './SessionChat.module.css';

let idCounter = 0;
const nextId = () => `sc-${++idCounter}`;

/**
 * Chat scoped to a pipeline session. Passes the session id as the chat's
 * `conversation_id` so the backend agent loop persists the exchange under the
 * same id the session (and its documents/jobs) live under.
 */
export default function SessionChat({ sessionId }: { sessionId: string }) {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [streamingMsg, setStreamingMsg] = useState<ChatMessageType | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset the chat when switching sessions.
  useEffect(() => {
    setFeed([]);
    setStreamingMsg(null);
    setIsStreaming(false);
    setIsWaiting(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed, streamingMsg, isWaiting]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (isStreaming) return;

    const userMsg: ChatMessageType = { id: nextId(), role: 'user', content: text };
    setFeed((prev) => [...prev, { kind: 'message', message: userMsg }]);
    setIsStreaming(true);
    setIsWaiting(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = nextId();
    let assistantText = '';

    const appendAssistant = (chunk: string) => {
      assistantText += chunk;
      setStreamingMsg({ id: assistantId, role: 'assistant', content: assistantText });
    };
    const addEvent = (event: AgentEvent) => setFeed((prev) => [...prev, { kind: 'event', event }]);

    try {
      const response = await sendChatRequest(text, sessionId, controller.signal);
      setIsWaiting(false);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let pendingEventType: string | null = null;

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
              if (pendingEventType) {
                addEvent({
                  id: nextId(),
                  type: pendingEventType as AgentEvent['type'],
                  data,
                  timestamp: Date.now(),
                });
                pendingEventType = null;
                continue;
              }
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) appendAssistant(delta.content);
            } catch {
              /* skip unparseable lines */
            }
            pendingEventType = null;
          }
        }
      }
    } catch (err) {
      setIsWaiting(false);
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (assistantText) appendAssistant('\n\n*[Stopped]*');
      } else {
        appendAssistant(`\n\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      if (assistantText) {
        const finalMsg: ChatMessageType = { id: assistantId, role: 'assistant', content: assistantText };
        setFeed((prev) => [...prev, { kind: 'message', message: finalMsg }]);
      }
      setStreamingMsg(null);
    }
  }, [isStreaming, sessionId]);

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>Chat · scoped to this session's documents</div>

      <div className={styles.chat} ref={chatRef}>
        {feed.length === 0 && !isStreaming && (
          <div className={styles.empty}>
            Ask about the documents retrieved in this session — extraction, provisions, comparisons.
          </div>
        )}

        {feed.map((item) =>
          item.kind === 'message'
            ? <ChatMessage key={item.message.id} message={item.message} />
            : <AgentEventCard key={item.event.id} event={item.event} />,
        )}

        {isWaiting && <ThinkingDots />}
        {streamingMsg && <ChatMessage key={streamingMsg.id} message={streamingMsg} />}
      </div>

      <ChatInput onSend={handleSend} onStop={handleStop} isStreaming={isStreaming} />
    </div>
  );
}
