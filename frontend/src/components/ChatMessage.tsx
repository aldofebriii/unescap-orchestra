import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage as ChatMessageType } from '../types';
import styles from './ChatMessage.module.css';

export default function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === 'user';

  return (
    <div className={`${styles.message} ${isUser ? styles.user : styles.assistant}`}>
      <div className={`${styles.avatar} ${isUser ? styles.avatarUser : styles.avatarAgent}`}>
        {isUser ? 'You' : 'AI'}
      </div>
      <div className={styles.content}>
        <div className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant}`}>
          {isUser ? (
            // User messages: plain text (no markdown needed)
            <span>{message.content}</span>
          ) : (
            // Assistant messages: full Markdown rendering
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Open links in new tab
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                ),
                // Code blocks with monospace font
                code: ({ children, className }) => {
                  const isBlock = className?.startsWith('language-');
                  return isBlock ? (
                    <pre className={styles.codeBlock}>
                      <code className={className}>{children}</code>
                    </pre>
                  ) : (
                    <code className={styles.inlineCode}>{children}</code>
                  );
                },
                // Tables
                table: ({ children }) => (
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>{children}</table>
                  </div>
                ),
                // Blockquotes
                blockquote: ({ children }) => (
                  <blockquote className={styles.blockquote}>{children}</blockquote>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
