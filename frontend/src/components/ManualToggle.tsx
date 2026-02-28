import { useState } from "react";
import styles from "./ManualToggle.module.css";

interface Props {
  isOn: boolean;
  onToggle: (newState: boolean) => void;
}

export function ManualToggle({ isOn, onToggle }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    const newState = !isOn;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: newState ? "on" : "off" }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to toggle");

      // Optimistic update handled by parent via refetch
      onToggle(newState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      <span className={styles.label}>Manual Control</span>

      <button
        className={`${styles.button} ${isOn ? styles.turnOff : styles.turnOn}`}
        onClick={handleToggle}
        disabled={loading}
        aria-label={isOn ? "Turn boiler off" : "Turn boiler on"}
      >
        {loading ? (
          <span className={styles.spinner} />
        ) : (
          <>
            <span className={styles.icon}>{isOn ? "⏹" : "▶"}</span>
            {isOn ? "Turn OFF" : "Turn ON"}
          </>
        )}
      </button>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
