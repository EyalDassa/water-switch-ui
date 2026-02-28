import { useState, useEffect, useCallback, useRef } from "react";

export interface DeviceStatus {
  isOn: boolean;
  countdownSeconds: number;
  lastUpdated: Date | null;
  error: string | null;
  loading: boolean;
  /** HH:MM when the current countdown started (null if no countdown) */
  countdownStartTime: string | null;
  /** HH:MM when the current countdown will end (null if no countdown) */
  countdownEndTime: string | null;
}

function formatHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function useDeviceStatus(onSchedulesChanged?: () => void) {
  const [status, setStatus] = useState<DeviceStatus>({
    isOn: false,
    countdownSeconds: 0,
    lastUpdated: null,
    error: null,
    loading: true,
    countdownStartTime: null,
    countdownEndTime: null,
  });

  // Track the total countdown duration (captured when countdown first appears)
  const countdownTotalRef = useRef<number | null>(null);
  const schedulesChangedRef = useRef(onSchedulesChanged);
  schedulesChangedRef.current = onSchedulesChanged;

  const processStatus = useCallback((data: { isOn: boolean; countdownSeconds: number }) => {
    const countdown = data.countdownSeconds ?? 0;

    let countdownStartTime: string | null = null;
    let countdownEndTime: string | null = null;

    if (countdown > 0 && data.isOn) {
      if (countdownTotalRef.current === null) {
        countdownTotalRef.current = countdown;
      }

      const now = new Date();
      const total = countdownTotalRef.current;
      const elapsed = total - countdown;

      const startDate = new Date(now.getTime() - elapsed * 1000);
      const endDate = new Date(now.getTime() + countdown * 1000);

      countdownStartTime = formatHHMM(startDate);
      countdownEndTime = formatHHMM(endDate);
    } else {
      countdownTotalRef.current = null;
    }

    setStatus({
      isOn: data.isOn,
      countdownSeconds: countdown,
      lastUpdated: new Date(),
      error: null,
      loading: false,
      countdownStartTime,
      countdownEndTime,
    });
  }, []);

  // SSE connection
  useEffect(() => {
    const eventSource = new EventSource("/api/events");

    eventSource.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data);
        processStatus(data);
      } catch {
        // Ignore malformed events
      }
    });

    eventSource.addEventListener("schedules-changed", () => {
      schedulesChangedRef.current?.();
    });

    eventSource.onerror = () => {
      setStatus((prev) => ({
        ...prev,
        error: prev.loading ? "Connection error" : null,
        loading: false,
      }));
      // EventSource auto-reconnects
    };

    return () => eventSource.close();
  }, [processStatus]);

  // Manual refetch fallback
  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      processStatus(data);
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Connection error",
        loading: false,
      }));
    }
  }, [processStatus]);

  return { status, refetch };
}
