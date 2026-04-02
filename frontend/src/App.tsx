import { useState, useCallback, useEffect, useRef } from "react";
import { SignedIn, SignedOut, SignIn, UserButton, useUser } from "@clerk/clerk-react";
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
import { DeviceSetup } from "./components/DeviceSetup";
import { TeamPanel } from "./components/TeamPanel";
import { InviteModal } from "./components/InviteModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { setScheduleColorIndex } from "./scheduleColors";
import styles from "./App.module.css";

export default function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.titleGroup}>
            <span className={styles.droplet}>💧</span>
            <h1 className={styles.title}>Water Boiler</h1>
          </div>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
      </header>

      <SignedOut>
        <main className={styles.signInContainer}>
          <SignIn routing="hash" />
        </main>
      </SignedOut>

      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
    </div>
  );
}

function AuthenticatedApp() {
  const { user } = useUser();
  const [deviceConfigured, setDeviceConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    const meta = user?.publicMetadata as { configured?: boolean } | undefined;
    setDeviceConfigured(!!meta?.configured);
  }, [user]);

  if (deviceConfigured === null) return null; // loading

  if (!deviceConfigured) {
    return (
      <DeviceSetup
        onComplete={() => {
          // Reload to pick up new session claims with updated metadata
          window.location.reload();
        }}
      />
    );
  }

  const meta = user?.publicMetadata as { role?: string; canInvite?: boolean } | undefined;
  const role = (meta?.role || "admin") as "admin" | "member";
  const userCanInvite = meta?.canInvite ?? role === "admin";

  return <Dashboard role={role} canInvite={userCanInvite} />;
}

function Dashboard({ role, canInvite }: { role: "admin" | "member"; canInvite: boolean }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [editorState, setEditorState] = useState<{ show: boolean; initial?: ScheduleEditData }>({ show: false });
  const [showInvite, setShowInvite] = useState(false);

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const scheds = data.schedules || [];
      // Register explicit colors from schedule data
      for (const s of scheds) {
        if (s.groupId && s.colorIndex != null) {
          setScheduleColorIndex(s.groupId, s.colorIndex);
        }
      }
      setSchedules(scheds);
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

  // Re-fetch history on ON/OFF transitions and new countdown starts
  const prevIsOnRef = useRef(status.isOn);
  const prevCountdownRef = useRef(status.countdownSeconds);
  useEffect(() => {
    if (status.loading) return;
    const isOnChanged = status.isOn !== prevIsOnRef.current;
    const newCountdownStarted = status.countdownSeconds > prevCountdownRef.current;
    prevIsOnRef.current = status.isOn;
    prevCountdownRef.current = status.countdownSeconds;

    if (isOnChanged || newCountdownStarted) {
      const timer = setTimeout(fetchHistory, 3000);
      return () => clearTimeout(timer);
    }
  }, [status.isOn, status.countdownSeconds, status.loading, fetchHistory]);

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
    <>
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
            <HistoryCard runs={history} />
          </div>

          {/* Right column on desktop: controls */}
          <div className={styles.rightCol}>
            <ManualToggle isOn={status.isOn} />
            <CountdownCard
              countdownSeconds={status.countdownSeconds}
            />
            <ScheduleList
              schedules={schedules}
              onChanged={fetchSchedules}
              onEdit={openEditor}
            />
            {schedulesError && (
              <p className={styles.schedulesError}>{schedulesError}</p>
            )}
            <TeamPanel
              role={role}
              canInvite={canInvite}
              onShowInvite={() => setShowInvite(true)}
            />
            <SettingsPanel />
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

      {showInvite && (
        <InviteModal onClose={() => setShowInvite(false)} />
      )}
    </>
  );
}
