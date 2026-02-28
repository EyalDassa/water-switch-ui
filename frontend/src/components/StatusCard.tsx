import type { DeviceStatus } from "../hooks/useDeviceStatus";
import styles from "./StatusCard.module.css";

interface Props {
  status: DeviceStatus;
  schedules: Schedule[];
}

export interface Schedule {
  id: string;
  groupId?: string;
  name?: string;
  isEnabled: boolean;
  time: string; // "HH:MM"
  days: string[];
  action: "on" | "off";
}

function formatRelativeTime(date: Date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

function getNextEvent(schedules: Schedule[]): string | null {
  if (!schedules.length) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayDayIdx = (now.getDay() + 6) % 7; // 0=Mon...6=Sun
  const dayNames = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  // Collect all today's enabled events and upcoming ones
  const events = schedules
    .filter((s) => s.isEnabled)
    .map((s) => {
      const [h, m] = s.time.split(":").map(Number);
      const eventMinutes = h * 60 + m;
      const isToday =
        s.days.includes("daily") ||
        s.days.includes(dayNames[todayDayIdx]) ||
        (s.days.includes("weekdays") && todayDayIdx < 5) ||
        (s.days.includes("weekends") && todayDayIdx >= 5);

      const minutesUntil = isToday
        ? eventMinutes > nowMinutes
          ? eventMinutes - nowMinutes
          : null
        : null;

      return { ...s, minutesUntil };
    })
    .filter((s) => s.minutesUntil !== null)
    .sort((a, b) => (a.minutesUntil ?? 0) - (b.minutesUntil ?? 0));

  if (!events.length) return null;

  const next = events[0];
  const mins = next.minutesUntil!;
  const label = next.action === "on" ? "turns ON" : "turns OFF";

  if (mins < 60) return `${label} in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${label} in ${h}h${m > 0 ? ` ${m}m` : ""}`;
}

export function StatusCard({ status, schedules }: Props) {
  const nextEvent = getNextEvent(schedules);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.label}>Status</span>
        {status.lastUpdated && (
          <span className={styles.updated}>
            Updated {formatRelativeTime(status.lastUpdated)}
          </span>
        )}
      </div>

      <div className={styles.statusRow}>
        <span
          className={`${styles.dot} ${status.isOn ? styles.dotOn : styles.dotOff}`}
        />
        <span className={`${styles.statusText} ${status.isOn ? styles.on : styles.off}`}>
          {status.loading ? "Loading…" : status.isOn ? "ON" : "OFF"}
        </span>
      </div>

      {status.countdownSeconds > 0 && (
        <p className={styles.countdown}>
          Auto-off in{" "}
          <strong>
            {Math.ceil(status.countdownSeconds / 60)} min
          </strong>
        </p>
      )}

      {nextEvent && (
        <p className={styles.nextEvent}>{nextEvent}</p>
      )}

      {status.error && (
        <p className={styles.error}>{status.error}</p>
      )}
    </div>
  );
}
