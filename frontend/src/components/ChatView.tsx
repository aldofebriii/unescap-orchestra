import { useCallback, useEffect, useRef, useState } from 'react';
import Welcome from './Welcome';
import ChatMessage from './ChatMessage';
import AgentEventCard from './AgentEventCard';
import ChatInput from './ChatInput';
import ThinkingDots from './ThinkingDots';
import { sendChatRequest } from '../api';
import type { FeedItem, ChatMessage as ChatMessageType, AgentEvent } from '../types';
import styles from '../App.module.css';

let idCounter = 0;
const nextId = () => `item-${++idCounter}`;

export default function ChatView() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  // The assistant message being built is kept OUTSIDE feed during streaming
  // so it always renders AFTER all agent events (thinking, tool calls, etc.)
  const [streamingMsg, setStreamingMsg] = useState<ChatMessageType | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed, streamingMsg, isWaiting]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
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

    // Update the separate streaming message state (not feed)
    // This ensures it always renders BELOW all agent events
    const appendAssistant = (chunk: string) => {
      assistantText += chunk;
      const content = assistantText;
      setStreamingMsg({ id: assistantId, role: 'assistant', content });
    };

    const addEvent = (event: AgentEvent) =>
      setFeed((prev) => [...prev, { kind: 'event', event }]);

    try {
      const response = await sendChatRequest(text, undefined, controller.signal);
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
              if (delta?.content) {
                appendAssistant(delta.content);
              }
            } catch {
              // skip unparseable lines
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

      // Move the completed assistant message into the feed and clear streaming state
      if (assistantText) {
        const finalMsg: ChatMessageType = { id: assistantId, role: 'assistant', content: assistantText };
        setFeed((prev) => [...prev, { kind: 'message', message: finalMsg }]);
      }
      setStreamingMsg(null);
    }
  }, [isStreaming]);

  return (
    <>
      <div className={styles.chat} ref={chatRef}>
        {feed.length === 0 && !isStreaming && <Welcome onSuggestion={handleSend} />}

        {feed.map((item) =>
          item.kind === 'message'
            ? <ChatMessage key={item.message.id} message={item.message} />
            : <AgentEventCard key={item.event.id} event={item.event} />,
        )}

        {/* Waiting indicator — shown before any data arrives */}
        {isWaiting && <ThinkingDots />}

        {/* Streaming assistant message always renders AFTER all feed items + events */}
        {streamingMsg && <ChatMessage key={streamingMsg.id} message={streamingMsg} />}
      </div>
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
      />
    </>
  );
}
