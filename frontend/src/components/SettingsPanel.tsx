import { useState, useEffect, useCallback } from "react";
import styles from "./SettingsPanel.module.css";

interface Settings {
  blockExternalActivations: boolean;
  isAdmin: boolean;
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      setSettings(await res.json());
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function toggleBlock() {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    const newValue = !settings.blockExternalActivations;
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockExternalActivations: newValue }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update");
      }
      setSettings({ ...settings, blockExternalActivations: newValue });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div className={styles.card}>
      <span className={styles.label}>Settings</span>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingName}>Block external activations</span>
          <span className={styles.settingDesc}>
            Auto-turn-off the device if it's activated externally (power spike,
            SmartLife, etc). Scheduled activations are not affected.
          </span>
        </div>
        <button
          className={`${styles.toggle} ${settings.blockExternalActivations ? styles.toggleOn : ""}`}
          onClick={toggleBlock}
          disabled={saving || !settings.isAdmin}
          title={!settings.isAdmin ? "Only the admin can change this" : ""}
        >
          <span className={styles.toggleKnob} />
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
