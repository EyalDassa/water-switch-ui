import { useEffect, useState, useRef, useCallback } from "react";
import type { Schedule } from "./StatusCard";
import type { ScheduleEditData } from "./ScheduleEditor";
import { formatDays } from "./ScheduleList";
import { getScheduleColor, getScheduleColorLight } from "../scheduleColors";
import styles from "./AnalogClock.module.css";

export interface HistoryRun {
  startTime: string;       // "HH:MM"
  endTime: string | null;  // "HH:MM" or null if still running
  durationSec: number;
}

interface Props {
  schedules: Schedule[];
  isOn: boolean;
  countdownStartTime?: string | null;
  countdownEndTime?: string | null;
  countdownSeconds?: number;
  history?: HistoryRun[];
  onEditSchedule?: (data: ScheduleEditData) => void;
}

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER_R = 120;
const INNER_R = 90;
const CLOCK_R = 78;
const LABEL_R = OUTER_R + 22;

function timeToAngle(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return ((h * 60 + m) / (24 * 60)) * 360;
}

function polarToCart(angleDeg: number, r: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function arcPath(startAngle: number, endAngle: number, outerR: number, innerR: number): string {
  let sweep = endAngle - startAngle;
  if (sweep < 0) sweep += 360;
  if (sweep === 0) return "";

  const largeArc = sweep > 180 ? 1 : 0;

  const o1 = polarToCart(startAngle, outerR);
  const o2 = polarToCart(startAngle + sweep, outerR);
  const i1 = polarToCart(startAngle + sweep, innerR);
  const i2 = polarToCart(startAngle, innerR);

  return [
    `M ${o1.x} ${o1.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${i2.x} ${i2.y}`,
    "Z",
  ].join(" ");
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function HourTicks() {
  const ticks = [];
  for (let h = 0; h < 24; h++) {
    const angle = (h / 24) * 360;
    const isMajor = h % 6 === 0;
    const outerR = OUTER_R + 6;
    const innerR = outerR - (isMajor ? 10 : 6);
    const p1 = polarToCart(angle, outerR);
    const p2 = polarToCart(angle, innerR);
    ticks.push(
      <line
        key={h}
        x1={p1.x} y1={p1.y}
        x2={p2.x} y2={p2.y}
        stroke={isMajor ? "#94a3b8" : "#cbd5e1"}
        strokeWidth={isMajor ? 2 : 1}
      />
    );

    if (h % 6 === 0) {
      const lp = polarToCart(angle, LABEL_R);
      ticks.push(
        <text
          key={`label-${h}`}
          x={lp.x} y={lp.y}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="11"
          fill="#94a3b8"
          fontFamily="Inter, sans-serif"
          fontWeight="600"
        >
          {String(h).padStart(2, "0")}:00
        </text>
      );
    }
  }
  return <>{ticks}</>;
}

// Unified tooltip info for any arc type
interface TooltipInfo {
  id: string;
  startAngle: number;
  endAngle: number;
  type: "schedule" | "countdown" | "history";
  // Schedule-specific
  name?: string;
  startTime?: string;
  endTime?: string;
  days?: string[];
  groupId?: string;
  color?: string;
  // Duration for history/countdown
  durationSec?: number;
}

export function AnalogClock({ schedules, isOn, countdownStartTime, countdownEndTime, countdownSeconds, history, onEditSchedule }: Props) {
  const [now, setNow] = useState(new Date());
  const [activeId, setActiveId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Dismiss tooltip on outside click (mobile)
  useEffect(() => {
    if (!activeId) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setActiveId(null);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [activeId]);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentAngle = (currentMinutes / (24 * 60)) * 360;

  // Build schedule arcs with metadata
  const onTimers = schedules.filter((s) => s.action === "on" && s.isEnabled);
  const offTimers = schedules.filter((s) => s.action === "off" && s.isEnabled);

  const scheduleArcs = onTimers.map((onTimer) => {
    const onAngle = timeToAngle(onTimer.time);
    const onMinutes = onTimer.time.split(":").map(Number).reduce((h, m) => h * 60 + m);

    const offTimer = offTimers.find((t) => t.groupId === onTimer.groupId)
      || offTimers
        .map((t) => {
          const offMinutes = t.time.split(":").map(Number).reduce((h, m) => h * 60 + m);
          const diff = offMinutes >= onMinutes ? offMinutes - onMinutes : 24 * 60 - onMinutes + offMinutes;
          return { ...t, diff };
        })
        .sort((a, b) => a.diff - b.diff)[0];

    const offAngle = offTimer ? timeToAngle(offTimer.time) : onAngle + 15;
    const groupId = onTimer.groupId || onTimer.id;

    let offMin = offTimer
      ? offTimer.time.split(":").map(Number).reduce((h: number, m: number) => h * 60 + m)
      : onMinutes + 15;
    if (offMin <= onMinutes) offMin += 24 * 60;
    const cur = currentMinutes >= onMinutes ? currentMinutes : currentMinutes + 24 * 60;
    const isActive = isOn && cur >= onMinutes && cur < offMin;

    return {
      onAngle,
      offAngle,
      groupId,
      isActive,
      name: onTimer.name,
      startTime: onTimer.time,
      endTime: offTimer?.time || onTimer.time,
      days: onTimer.days,
    };
  });

  // History arcs
  const historyArcs = (history || [])
    .filter((run) => run.endTime !== null)
    .map((run, i) => ({
      startAngle: timeToAngle(run.startTime),
      endAngle: timeToAngle(run.endTime!),
      key: `history-${i}`,
      startTime: run.startTime,
      endTime: run.endTime!,
      durationSec: run.durationSec,
    }));

  const hasCountdown = countdownStartTime && countdownEndTime;

  // Build a map of all tooltip-able arcs for unified positioning
  const allTooltips: TooltipInfo[] = [
    ...scheduleArcs.map((arc) => ({
      id: arc.groupId,
      startAngle: arc.onAngle,
      endAngle: arc.offAngle,
      type: "schedule" as const,
      name: arc.name,
      startTime: arc.startTime,
      endTime: arc.endTime,
      days: arc.days,
      groupId: arc.groupId,
      color: getScheduleColor(arc.groupId),
    })),
    ...historyArcs.map((arc) => ({
      id: arc.key,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
      type: "history" as const,
      startTime: arc.startTime,
      endTime: arc.endTime,
      durationSec: arc.durationSec,
      color: "#94a3b8",
    })),
    ...(hasCountdown ? [{
      id: "countdown",
      startAngle: timeToAngle(countdownStartTime!),
      endAngle: timeToAngle(countdownEndTime!),
      type: "countdown" as const,
      startTime: countdownStartTime!,
      endTime: countdownEndTime!,
      durationSec: countdownSeconds || 0,
      color: "#f97316",
    }] : []),
  ];

  const activeTooltip = allTooltips.find((t) => t.id === activeId);

  // Tooltip position from arc midpoint
  const getTooltipPosition = useCallback(() => {
    if (!activeTooltip || !svgRef.current || !wrapperRef.current) return null;

    let sweep = activeTooltip.endAngle - activeTooltip.startAngle;
    if (sweep < 0) sweep += 360;
    const midAngle = activeTooltip.startAngle + sweep / 2;

    const midR = (OUTER_R + INNER_R) / 2;
    const svgPoint = polarToCart(midAngle, midR);

    const svgEl = svgRef.current;
    const wrapperEl = wrapperRef.current;
    const svgRect = svgEl.getBoundingClientRect();
    const wrapperRect = wrapperEl.getBoundingClientRect();

    const scaleX = svgRect.width / SIZE;
    const scaleY = svgRect.height / SIZE;

    const pixelX = svgRect.left + svgPoint.x * scaleX - wrapperRect.left;
    const pixelY = svgRect.top + svgPoint.y * scaleY - wrapperRect.top;

    return { x: pixelX, y: pixelY };
  }, [activeTooltip]);

  function handleArcClick(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setActiveId((prev) => (prev === id ? null : id));
  }

  function handleEditClick(tooltip: TooltipInfo) {
    setActiveId(null);
    if (tooltip.type === "schedule" && tooltip.groupId) {
      onEditSchedule?.({
        id: tooltip.groupId,
        name: tooltip.name,
        startTime: tooltip.startTime!,
        endTime: tooltip.endTime!,
        days: tooltip.days!,
      });
    }
  }

  const tooltipPos = activeId ? getTooltipPosition() : null;

  // Time hand
  const handTip = polarToCart(currentAngle, INNER_R - 12);
  const handBase1 = polarToCart(currentAngle + 90, 5);
  const handBase2 = polarToCart(currentAngle - 90, 5);

  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <span className={styles.label}>Schedule</span>
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="24-hour schedule clock"
      >
        <defs>
          <style>{`
            @keyframes countdown-pulse {
              0%, 100% { opacity: 0.85; }
              50% { opacity: 0.55; }
            }
          `}</style>
        </defs>

        {/* Outer background ring */}
        <circle cx={CX} cy={CY} r={OUTER_R + 8} fill="#f1f5f9" />
        <circle cx={CX} cy={CY} r={INNER_R - 2} fill="white" />

        <HourTicks />

        {/* History arcs — interactive */}
        {historyArcs.map((arc) => (
          <path
            key={arc.key}
            d={arcPath(arc.startAngle, arc.endAngle, OUTER_R, INNER_R)}
            fill="#94a3b8"
            opacity={activeId === arc.key ? 0.3 : 0.15}
            style={{ cursor: "pointer", transition: "opacity 0.15s" }}
            onMouseEnter={() => setActiveId(arc.key)}
            onMouseLeave={() => setActiveId(null)}
            onClick={(e) => handleArcClick(arc.key, e)}
          />
        ))}

        {/* Schedule arcs — interactive */}
        {scheduleArcs.map((arc) => (
          <path
            key={arc.groupId}
            d={arcPath(arc.onAngle, arc.offAngle, OUTER_R, INNER_R)}
            fill={arc.isActive ? getScheduleColor(arc.groupId) : getScheduleColorLight(arc.groupId)}
            opacity={activeId === arc.groupId ? 1 : 0.9}
            stroke={activeId === arc.groupId ? getScheduleColor(arc.groupId) : "none"}
            strokeWidth={activeId === arc.groupId ? 2 : 0}
            style={{ cursor: "pointer", transition: "opacity 0.15s" }}
            onMouseEnter={() => setActiveId(arc.groupId)}
            onMouseLeave={() => setActiveId(null)}
            onClick={(e) => handleArcClick(arc.groupId, e)}
          />
        ))}

        {/* Countdown arc — interactive */}
        {hasCountdown && (
          <path
            d={arcPath(timeToAngle(countdownStartTime!), timeToAngle(countdownEndTime!), OUTER_R, INNER_R)}
            fill="#f97316"
            style={{ cursor: "pointer", animation: "countdown-pulse 2s ease-in-out infinite" }}
            onMouseEnter={() => setActiveId("countdown")}
            onMouseLeave={() => setActiveId(null)}
            onClick={(e) => handleArcClick("countdown", e)}
          />
        )}

        {/* Clock face */}
        <circle cx={CX} cy={CY} r={CLOCK_R} fill="white" />
        <circle cx={CX} cy={CY} r={CLOCK_R} fill="none" stroke="#e2e8f0" strokeWidth="1" />

        {/* Time hand */}
        <polygon
          points={`${handTip.x},${handTip.y} ${handBase1.x},${handBase1.y} ${handBase2.x},${handBase2.y}`}
          fill={isOn ? "#3b82f6" : "#94a3b8"}
        />

        {/* Center dot */}
        <circle cx={CX} cy={CY} r={5} fill={isOn ? "#3b82f6" : "#94a3b8"} />

        {/* Digital time */}
        <text
          x={CX}
          y={CY + 26}
          textAnchor="middle"
          fontSize="18"
          fontWeight="600"
          fill="#1a202c"
          fontFamily="Inter, sans-serif"
          letterSpacing="-0.5"
        >
          {hours}:{minutes}
        </text>
      </svg>

      {/* Tooltip — works for all arc types */}
      {activeTooltip && tooltipPos && (
        <div
          className={styles.tooltip}
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
          onMouseEnter={() => setActiveId(activeTooltip.id)}
          onMouseLeave={() => setActiveId(null)}
        >
          <div
            className={styles.tooltipAccent}
            style={{ background: activeTooltip.color }}
          />
          <div className={styles.tooltipContent}>
            {activeTooltip.type === "schedule" && activeTooltip.name && (
              <span className={styles.tooltipName}>{activeTooltip.name}</span>
            )}
            {activeTooltip.type === "countdown" && (
              <span className={styles.tooltipName}>Manual run</span>
            )}
            {activeTooltip.type === "history" && (
              <span className={styles.tooltipName}>Past run</span>
            )}
            <span className={styles.tooltipTime}>
              {activeTooltip.startTime} → {activeTooltip.endTime}
            </span>
            {activeTooltip.type === "schedule" && activeTooltip.days && (
              <span className={styles.tooltipDays}>{formatDays(activeTooltip.days)}</span>
            )}
            {(activeTooltip.type === "countdown" || activeTooltip.type === "history") && activeTooltip.durationSec != null && (
              <span className={styles.tooltipDays}>
                {activeTooltip.type === "countdown" ? `${formatDuration(activeTooltip.durationSec)} remaining` : formatDuration(activeTooltip.durationSec)}
              </span>
            )}
          </div>
          {activeTooltip.type === "schedule" && onEditSchedule && (
            <button
              className={styles.tooltipEdit}
              onClick={() => handleEditClick(activeTooltip)}
            >
              Edit
            </button>
          )}
        </div>
      )}

      {scheduleArcs.length === 0 && !hasCountdown && historyArcs.length === 0 && (
        <p className={styles.noSchedule}>No schedules set</p>
      )}
    </div>
  );
}
