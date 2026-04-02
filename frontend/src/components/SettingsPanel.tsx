import { useState, useEffect, useCallback } from "react";
import styles from "./SettingsPanel.module.css";

interface Settings {
  blockExternalActivations: boolean;
  blockAfterOneHour: boolean;
  guardMaxMinutes: number;
  isAdmin: boolean;
}

const DURATION_OPTIONS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1.5 hours" },
  { value: 120, label: "2 hours" },
];

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [expanded, setExpanded] = useState(false);
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

  async function updateSetting(patch: Partial<Settings>) {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update");
      }
      const data = await res.json();
      setSettings({
        ...settings,
        blockExternalActivations: data.blockExternalActivations,
        blockAfterOneHour: data.blockAfterOneHour,
        guardMaxMinutes: data.guardMaxMinutes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div className={styles.card}>
      <button
        className={styles.headerButton}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={styles.label}>Settings</span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>
          &#9662;
        </span>
      </button>

      {expanded && (
        <div className={styles.content}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingName}>
                Block all external activations
              </span>
              <span className={styles.settingDesc}>
                Immediately turn off the device if activated externally (power
                spike, SmartLife, physical button). Schedules are not affected.
              </span>
            </div>
            <button
              className={`${styles.toggle} ${settings.blockExternalActivations ? styles.toggleOn : ""}`}
              onClick={() =>
                updateSetting({
                  blockExternalActivations: !settings.blockExternalActivations,
                })
              }
              disabled={saving || !settings.isAdmin}
              title={!settings.isAdmin ? "Only the admin can change this" : ""}
            >
              <span className={styles.toggleKnob} />
            </button>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingName}>
                Auto-off after max run time
              </span>
              <span className={styles.settingDesc}>
                Automatically turn off the device after the selected duration to
                prevent unattended long runs.
              </span>
            </div>
            <button
              className={`${styles.toggle} ${settings.blockAfterOneHour ? styles.toggleOn : ""}`}
              onClick={() =>
                updateSetting({
                  blockAfterOneHour: !settings.blockAfterOneHour,
                })
              }
              disabled={
                saving ||
                !settings.isAdmin ||
                settings.blockExternalActivations
              }
              title={
                !settings.isAdmin
                  ? "Only the admin can change this"
                  : settings.blockExternalActivations
                    ? "Disable 'Block all' first to use this option"
                    : ""
              }
            >
              <span className={styles.toggleKnob} />
            </button>
          </div>

          {settings.blockAfterOneHour && (
            <div className={styles.durationRow}>
              <span className={styles.durationLabel}>Max run time:</span>
              <div className={styles.durationOptions}>
                {DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`${styles.durationBtn} ${settings.guardMaxMinutes === opt.value ? styles.durationBtnActive : ""}`}
                    onClick={() => updateSetting({ guardMaxMinutes: opt.value })}
                    disabled={saving || !settings.isAdmin}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </div>
  );
}
