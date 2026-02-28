import { useState } from "react";
import styles from "./CountdownCard.module.css";

interface Props {
  countdownSeconds: number;
  onStarted: () => void;
}

const PRESETS = [15, 30, 45, 60];

export function CountdownCard({ countdownSeconds, onStarted }: Props) {
  const [customMinutes, setCustomMinutes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCountdown(minutes: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/countdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start countdown");
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    const mins = parseInt(customMinutes, 10);
    if (!mins || mins < 1 || mins > 1440) {
      setError("Enter a number between 1 and 1440 minutes");
      return;
    }
    startCountdown(mins);
  }

  const remaining = countdownSeconds > 0 ? Math.ceil(countdownSeconds / 60) : null;

  return (
    <div className={styles.card}>
      <span className={styles.label}>Quick Timer</span>

      {remaining !== null && (
        <div className={styles.active}>
          <span className={styles.activeIcon}>⏱</span>
          <span>Auto-off in <strong>{remaining} min</strong></span>
        </div>
      )}

      <div className={styles.presets}>
        {PRESETS.map((min) => (
          <button
            key={min}
            className={styles.preset}
            onClick={() => startCountdown(min)}
            disabled={loading}
          >
            {min}<span className={styles.unit}>min</span>
          </button>
        ))}
      </div>

      <form className={styles.customForm} onSubmit={handleCustomSubmit}>
        <input
          type="number"
          className={styles.input}
          placeholder="Custom min"
          value={customMinutes}
          onChange={(e) => setCustomMinutes(e.target.value)}
          min={1}
          max={1440}
          disabled={loading}
          aria-label="Custom countdown minutes"
        />
        <button type="submit" className={styles.goButton} disabled={loading || !customMinutes}>
          {loading ? "…" : "Go"}
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
