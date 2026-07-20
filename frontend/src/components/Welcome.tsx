import styles from './Welcome.module.css';

const SUGGESTIONS = [
  "Find Indonesia's data protection law",
  "Search for Malaysia's cybersecurity act",
  "Find Thailand's PDPA regulation",
];

export default function Welcome({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.icon}>⚖️</div>
      <h2 className={styles.heading}>UNESCAP RDTII Agent</h2>
      <p className={styles.desc}>
        I can find, retrieve, and analyze legal and regulatory documents from
        government websites across Asia-Pacific countries.
      </p>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((s) => (
          <button key={s} className={styles.chip} onClick={() => onSuggestion(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}
