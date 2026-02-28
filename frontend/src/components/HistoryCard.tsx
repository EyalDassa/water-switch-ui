import type { HistoryRun } from "./AnalogClock";
import styles from "./HistoryCard.module.css";

interface Props {
  runs: HistoryRun[];
  totalSeconds: number;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function HistoryCard({ runs, totalSeconds }: Props) {
  if (runs.length === 0) {
    return (
      <div className={styles.card}>
        <span className={styles.label}>Today's Activity</span>
        <p className={styles.empty}>No runs today</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <span className={styles.label}>Today's Activity</span>
      <div className={styles.summary}>
        {runs.length} {runs.length === 1 ? "run" : "runs"}, {formatDuration(totalSeconds)} total
      </div>
      <div className={styles.list}>
        {runs.map((run, i) => (
          <div key={i} className={styles.run}>
            <span className={styles.dot} />
            <span className={styles.time}>
              {run.startTime} – {run.endTime ?? "now"}
            </span>
            <span className={styles.duration}>{formatDuration(run.durationSec)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
