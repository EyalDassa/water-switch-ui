import { useState } from "react";
import styles from "./ScheduleEditor.module.css";

export interface ScheduleEditData {
  id?: string;        // present when editing
  name?: string;
  startTime: string;
  endTime: string;
  days: string[];
}

interface Props {
  initial?: ScheduleEditData;
  onSave: () => void;
  onCancel: () => void;
}

const ALL_DAYS = [
  { key: "mon", label: "Mo" },
  { key: "tue", label: "Tu" },
  { key: "wed", label: "We" },
  { key: "thu", label: "Th" },
  { key: "fri", label: "Fr" },
  { key: "sat", label: "Sa" },
  { key: "sun", label: "Su" },
];

function detectRepeatMode(days: string[]): "daily" | "weekdays" | "weekends" | "custom" {
  if (days.includes("daily")) return "daily";
  if (days.includes("weekdays")) return "weekdays";
  if (days.includes("weekends")) return "weekends";
  return "custom";
}

export function ScheduleEditor({ initial, onSave, onCancel }: Props) {
  const isEditing = !!initial?.id;

  const [name, setName] = useState(initial?.name || "");
  const [startTime, setStartTime] = useState(initial?.startTime || "06:30");
  const [endTime, setEndTime] = useState(initial?.endTime || "07:00");
  const [repeatMode, setRepeatMode] = useState<"daily" | "weekdays" | "weekends" | "custom">(
    initial ? detectRepeatMode(initial.days) : "daily"
  );
  const [customDays, setCustomDays] = useState<string[]>(
    initial && detectRepeatMode(initial.days) === "custom" ? initial.days : ["mon", "tue", "wed", "thu", "fri"]
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleDay(day: string) {
    setCustomDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  function getDays(): string[] {
    if (repeatMode === "daily") return ["daily"];
    if (repeatMode === "weekdays") return ["weekdays"];
    if (repeatMode === "weekends") return ["weekends"];
    return customDays;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    const days = getDays();
    if (days.length === 0) {
      setError("Select at least one day");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = { name: name || undefined, startTime, endTime, days };

      const res = isEditing
        ? await fetch(`/api/schedules/${initial!.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/schedules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving schedule");
      setLoading(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.title}>{isEditing ? "Edit Schedule" : "Add Schedule"}</h2>
          <button className={styles.closeButton} onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSave} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name (optional)</label>
            <input
              type="text"
              className={styles.nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning boost"
            />
          </div>

          <div className={styles.timeRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Turn ON at</label>
              <input
                type="time"
                className={styles.timeInput}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
              />
            </div>
            <span className={styles.arrow}>→</span>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Turn OFF at</label>
              <input
                type="time"
                className={styles.timeInput}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Repeat</label>
            <div className={styles.repeatOptions}>
              {(["daily", "weekdays", "weekends", "custom"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${styles.repeatButton} ${repeatMode === mode ? styles.repeatActive : ""}`}
                  onClick={() => setRepeatMode(mode)}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {repeatMode === "custom" && (
            <div className={styles.dayPicker}>
              {ALL_DAYS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.dayButton} ${customDays.includes(key) ? styles.dayActive : ""}`}
                  onClick={() => toggleDay(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <button type="button" className={styles.cancelButton} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={styles.saveButton} disabled={loading}>
              {loading ? "Saving…" : isEditing ? "Update" : "Save Schedule"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
