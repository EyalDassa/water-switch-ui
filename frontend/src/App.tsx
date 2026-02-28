import { useState, useCallback, useEffect, useRef } from "react";
import { useDeviceStatus } from "./hooks/useDeviceStatus";
import { AnalogClock } from "./components/AnalogClock";
import type { HistoryRun } from "./components/AnalogClock";
import { StatusCard } from "./components/StatusCard";
import type { Schedule } from "./components/StatusCard";
import { ManualToggle } from "./components/ManualToggle";
import { CountdownCard } from "./components/CountdownCard";
import { ScheduleList } from "./components/ScheduleList";
import { ScheduleEditor } from "./components/ScheduleEditor";
import type { ScheduleEditData } from "./components/ScheduleEditor";
import { HistoryCard } from "./components/HistoryCard";
import styles from "./App.module.css";

export default function App() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [editorState, setEditorState] = useState<{ show: boolean; initial?: ScheduleEditData }>({ show: false });

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSchedules(data.schedules || []);
      setSchedulesError(null);
    } catch (err) {
      setSchedulesError(err instanceof Error ? err.message : "Failed to load schedules");
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      if (!res.ok) return;
      const data = await res.json();
      setHistory(data.runs || []);
      setHistoryTotal(data.totalSeconds || 0);
    } catch {
      // History is non-critical — silently ignore errors
    }
  }, []);

  // SSE handles status updates + schedules-changed events
  const { status } = useDeviceStatus(fetchSchedules);

  // Fetch schedules + history once on mount
  useEffect(() => {
    fetchSchedules();
    fetchHistory();
  }, [fetchSchedules, fetchHistory]);

  // Re-fetch history when isOn transitions (device turned on or off)
  const prevIsOnRef = useRef(status.isOn);
  useEffect(() => {
    if (status.loading) return;
    if (status.isOn !== prevIsOnRef.current) {
      prevIsOnRef.current = status.isOn;
      // Delay slightly so Tuya has time to log the event
      setTimeout(fetchHistory, 3000);
    }
  }, [status.isOn, status.loading, fetchHistory]);

  function openEditor(initial?: ScheduleEditData) {
    setEditorState({ show: true, initial });
  }

  function closeEditor() {
    setEditorState({ show: false });
  }

  function handleEditorSave() {
    closeEditor();
    // SSE will trigger fetchSchedules via schedules-changed event,
    // but also fetch eagerly for immediate UI feedback
    fetchSchedules();
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.titleGroup}>
            <span className={styles.droplet}>💧</span>
            <h1 className={styles.title}>Water Boiler</h1>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.grid}>
          {/* Left column on desktop: clock + status + history */}
          <div className={styles.leftCol}>
            <AnalogClock
              schedules={schedules}
              isOn={status.isOn}
              countdownStartTime={status.countdownStartTime}
              countdownEndTime={status.countdownEndTime}
              countdownSeconds={status.countdownSeconds}
              history={history}
              onEditSchedule={openEditor}
            />
            <StatusCard status={status} schedules={schedules} />
            <HistoryCard runs={history} totalSeconds={historyTotal} />
          </div>

          {/* Right column on desktop: controls */}
          <div className={styles.rightCol}>
            <ManualToggle isOn={status.isOn} onToggle={() => {}} />
            <CountdownCard
              countdownSeconds={status.countdownSeconds}
              onStarted={() => {}}
            />
            <ScheduleList
              schedules={schedules}
              onChanged={fetchSchedules}
              onEdit={openEditor}
            />
            {schedulesError && (
              <p className={styles.schedulesError}>{schedulesError}</p>
            )}
          </div>
        </div>
      </main>

      {editorState.show && (
        <ScheduleEditor
          initial={editorState.initial}
          onSave={handleEditorSave}
          onCancel={closeEditor}
        />
      )}
    </div>
  );
}
