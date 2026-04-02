import { useState, useEffect } from "react";
import type { HistoryRun } from "./AnalogClock";
import styles from "./HistoryCard.module.css";

const SOURCE_LABELS: Record<string, { text: string; color: string }> = {
  scheduled:            { text: "Scheduled",          color: "#8b5cf6" },
  quick_timer:          { text: "Quick Timer (UI)",   color: "#f97316" },
  quick_timer_external: { text: "Timer (External)",   color: "#f97316" },
  manual:               { text: "Manual (UI)",        color: "#3b82f6" },
  external:             { text: "Manual (External)",  color: "#64748b" },
  blocked:              { text: "Blocked by Guard",   color: "#ef4444" },
};

interface Props {
  runs: HistoryRun[];
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
  // Tick every 30s to update the "now" run's duration locally
  const hasActiveRun = runs.some((r) => r.endTime === null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, [hasActiveRun]);

  // Suppress unused-variable warning — tick drives re-renders
  void tick;

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
    const duration = run.endTime === null
      ? Math.round((Date.now() - parseStartTime(run.date, run.startTime)) / 1000)
      : run.durationSec;
    dayTotals.set(run.date, (dayTotals.get(run.date) || 0) + duration);
  }

  let lastDate = "";

  return (
    <div className={styles.card}>
      <span className={styles.label}>Recent Activity</span>
      <div className={styles.list}>
        {reversed.map((run, i) => {
          const showDate = run.date !== lastDate;
          lastDate = run.date;
          const isActive = run.endTime === null;
          const displayDuration = isActive
            ? Math.round((Date.now() - parseStartTime(run.date, run.startTime)) / 1000)
            : run.durationSec;
          return (
            <div key={i}>
              {showDate && (
                <div className={styles.dateHeader}>
                  <span>{formatDate(run.date)}</span>
                  <span className={styles.dayTotal}>{formatDuration(dayTotals.get(run.date)!)}</span>
                </div>
              )}
              <div className={`${styles.run} ${run.source === "blocked" ? styles.runBlocked : ""}`}>
                <span className={`${styles.dot} ${run.source === "blocked" ? styles.dotBlocked : ""}`} />
                <span className={styles.time}>
                  {run.startTime} – {run.endTime ?? "now"}
                </span>
                {run.source && SOURCE_LABELS[run.source] && (
                  <span className={styles.source} style={{ color: SOURCE_LABELS[run.source].color }}>
                    {SOURCE_LABELS[run.source].text}
                    {run.userName && <span className={styles.userName}> · {run.userName}</span>}
                  </span>
                )}
                <span className={styles.duration}>{formatDuration(displayDuration)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Parse "YYYY-MM-DD" + "HH:MM" into a timestamp */
function parseStartTime(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
}
