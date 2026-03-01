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

function formatDate(dateStr: string): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

  if (dateStr === today) return "Today";
  if (dateStr === yesterdayStr) return "Yesterday";

  const [, m, d] = dateStr.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

export function HistoryCard({ runs }: Props) {
  if (runs.length === 0) {
    return (
      <div className={styles.card}>
        <span className={styles.label}>Recent Activity</span>
        <p className={styles.empty}>No recent runs</p>
      </div>
    );
  }

  // Group runs by date (newest-first) with daily totals
  const reversed = [...runs].reverse();
  const dayTotals = new Map<string, number>();
  for (const run of reversed) {
    dayTotals.set(run.date, (dayTotals.get(run.date) || 0) + run.durationSec);
  }

  let lastDate = "";

  return (
    <div className={styles.card}>
      <span className={styles.label}>Recent Activity</span>
      <div className={styles.list}>
        {reversed.map((run, i) => {
          const showDate = run.date !== lastDate;
          lastDate = run.date;
          return (
            <div key={i}>
              {showDate && (
                <div className={styles.dateHeader}>
                  <span>{formatDate(run.date)}</span>
                  <span className={styles.dayTotal}>{formatDuration(dayTotals.get(run.date)!)}</span>
                </div>
              )}
              <div className={styles.run}>
                <span className={styles.dot} />
                <span className={styles.time}>
                  {run.startTime} – {run.endTime ?? "now"}
                </span>
                <span className={styles.duration}>{formatDuration(run.durationSec)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
