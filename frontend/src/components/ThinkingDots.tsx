import styles from './ThinkingDots.module.css';

export default function ThinkingDots() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.dots}><span /><span /><span /></div>
    </div>
  );
}
