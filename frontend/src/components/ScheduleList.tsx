import { useState } from "react";
import type { Schedule } from "./StatusCard";
import type { ScheduleEditData } from "./ScheduleEditor";
import { getScheduleColor } from "../scheduleColors";
import styles from "./ScheduleList.module.css";

interface Props {
  schedules: Schedule[];
  onChanged: () => void;
  onEdit: (initial?: ScheduleEditData) => void;
}

const DAY_LABELS: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu",
  fri: "Fri", sat: "Sat", sun: "Sun",
  daily: "Daily", weekdays: "Weekdays", weekends: "Weekends",
};

export function formatDays(days: string[]): string {
  return days.map((d) => DAY_LABELS[d] || d).join(", ");
}

// Group ON/OFF pairs into schedule entries for display
function groupSchedules(schedules: Schedule[]) {
  const onTimers = schedules.filter((s) => s.action === "on");
  const offTimers = schedules.filter((s) => s.action === "off");

  return onTimers.map((on) => {
    const off = offTimers
      .filter((t) => t.groupId === on.groupId)
      .map((t) => {
        const onMin = on.time.split(":").map(Number).reduce((h, m) => h * 60 + m);
        const offMin = t.time.split(":").map(Number).reduce((h, m) => h * 60 + m);
        const diff = offMin >= onMin ? offMin - onMin : 24 * 60 - onMin + offMin;
        return { ...t, diff };
      })
      .sort((a, b) => a.diff - b.diff)[0];

    return { on, off };
  });
}

export function ScheduleList({ schedules, onChanged, onEdit }: Props) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grouped = groupSchedules(schedules);

  function openEditFor(on: Schedule, off?: Schedule) {
    onEdit({
      id: on.groupId,
      name: on.name,
      startTime: on.time,
      endTime: off?.time || on.time,
      days: on.days,
    });
  }

  async function deleteSchedule(groupId: string) {
    setDeletingId(groupId);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${groupId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function toggleEnabled(groupId: string, currentlyEnabled: boolean) {
    setError(null);
    try {
      const action = currentlyEnabled ? "disable" : "enable";
      const res = await fetch(`/api/schedules/${groupId}/${action}`, { method: "PUT" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Toggle failed");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toggle failed");
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.label}>Schedules</span>
        <button className={styles.addButton} onClick={() => onEdit()}>
          + Add
        </button>
      </div>

      {grouped.length === 0 && (
        <p className={styles.empty}>No schedules yet. Add one above.</p>
      )}

      <div className={styles.list}>
        {grouped.map(({ on, off }) => (
          <div key={on.groupId} className={`${styles.item} ${!on.isEnabled ? styles.disabled : ""}`}>
            <button
              className={styles.toggleButton}
              onClick={() => toggleEnabled(on.groupId!, on.isEnabled)}
              aria-label={on.isEnabled ? "Disable" : "Enable"}
            >
              <span
                className={styles.colorDot}
                style={{ background: on.isEnabled ? getScheduleColor(on.groupId!) : "#cbd5e1" }}
              />
            </button>

            <div className={styles.itemInfo} onClick={() => openEditFor(on, off)}>
              {on.name && <span className={styles.name}>{on.name}</span>}
              <span className={styles.timeRange}>
                {on.time}
                {off && <> → {off.time}</>}
              </span>
              <span className={styles.days}>{formatDays(on.days)}</span>
            </div>

            <div className={styles.itemActions}>
              <button
                className={styles.editButton}
                onClick={() => openEditFor(on, off)}
                aria-label="Edit schedule"
              >
                ✎
              </button>
              <button
                className={styles.deleteButton}
                onClick={() => deleteSchedule(on.groupId!)}
                disabled={deletingId === on.groupId}
                aria-label="Delete schedule"
              >
                {deletingId === on.groupId ? "…" : "✕"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
