import { Router } from "express";
import { createClerkClient } from "@clerk/express";
import { notifyStatusChange } from "../events.js";
import {
  recordAction,
  findOurAction,
  findActionsInRange,
} from "../actionTracker.js";
import { createLogger } from "../logger.js";

const log = createLogger("history");

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const router = Router();

// GET /api/status
router.get("/status", async (req, res) => {
  const { deviceId } = req.deviceConfig;
  try {
    let dps;
    let online = true;
    if (req.tuya.isSharing) {
      const [statusResult, infoResult] = await Promise.all([
        req.tuya.getDeviceStatus(deviceId),
        req.tuya.getDeviceInfo(deviceId).catch(() => null),
      ]);
      dps = Array.isArray(statusResult)
        ? statusResult
        : statusResult?.status || statusResult?.dpStatusRelationDTOS || [];
      if (infoResult) online = infoResult.online ?? infoResult.isOnline ?? true;
    } else {
      const [statusResult, infoResult] = await Promise.all([
        req.tuya.get(`/v1.0/iot-03/devices/${deviceId}/status`),
        req.tuya.get(`/v1.0/devices/${deviceId}`).catch(() => null),
      ]);
      dps = statusResult;
      if (infoResult) online = infoResult.online ?? true;
    }

    const switchDp =
      dps.find((dp) => dp.code === "switch_1") ??
      dps.find((dp) => dp.code === "switch");
    const countdownDp =
      dps.find((dp) => dp.code === "countdown_1") ??
      dps.find((dp) => dp.code === "countdown");

    res.json({
      isOn: switchDp?.value ?? false,
      countdownSeconds: countdownDp?.value ?? 0,
      online,
      rawDps: dps,
    });
  } catch (err) {
    log.error(`GET /status: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/toggle  { action: "on" | "off" }
router.post("/toggle", async (req, res) => {
  const { deviceId } = req.deviceConfig;
  const { action } = req.body;
  if (action !== "on" && action !== "off") {
    return res.status(400).json({ error: 'action must be "on" or "off"' });
  }

  const value = action === "on";

  try {
    if (req.tuya.isSharing) {
      await req.tuya.sendCommands(deviceId, [{ code: "switch_1", value }]);
    } else {
      await req.tuya.post(`/v1.0/iot-03/devices/${deviceId}/commands`, {
        commands: [{ code: "switch_1", value }],
      });
    }
    recordAction(deviceId, "toggle", action, req.deviceConfig.userId);
    log.event(
      `Manual toggle ${action.toUpperCase()} by user ${req.deviceConfig.userId?.slice(0, 8) || "unknown"}…`,
    );
    res.json({ success: true, isOn: value });
    notifyStatusChange(deviceId, req.tuya);
  } catch (firstErr) {
    // Fallback to legacy "switch" DP code
    try {
      if (req.tuya.isSharing) {
        await req.tuya.sendCommands(deviceId, [{ code: "switch", value }]);
      } else {
        await req.tuya.post(`/v1.0/iot-03/devices/${deviceId}/commands`, {
          commands: [{ code: "switch", value }],
        });
      }
      recordAction(deviceId, "toggle", action, req.deviceConfig.userId);
      log.event(
        `Manual toggle ${action.toUpperCase()} by user ${req.deviceConfig.userId?.slice(0, 8) || "unknown"}… (fallback DP)`,
      );
      res.json({ success: true, isOn: value });
      notifyStatusChange(deviceId, req.tuya);
    } catch (err) {
      log.error(`POST /toggle: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  }
});

// Fetch paginated logs for a single DP code (prevents countdown ticks drowning switch events)
async function fetchLogs(tuya, deviceId, startTime, endTime, code) {
  const seen = new Set();
  const logs = [];
  let lastRowKey = "";
  const MAX_PAGES = 5;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rowKeyParam = lastRowKey
      ? `&last_row_key=${encodeURIComponent(lastRowKey)}`
      : "";
    const data = await tuya.get(
      `/v1.0/devices/${deviceId}/logs?start_time=${startTime}&end_time=${endTime}&size=100&type=7&codes=${code}${rowKeyParam}`,
    );
    for (const log of data.logs || []) {
      const key = `${log.event_time}_${log.code}_${log.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        logs.push(log);
      }
    }
    if (
      !data.has_next ||
      !data.next_row_key ||
      data.next_row_key === lastRowKey
    )
      break;
    lastRowKey = data.next_row_key;
  }
  return logs;
}

// GET /api/history — 10 most recent ON/OFF run sessions from Tuya device logs
router.get("/history", async (req, res) => {
  const { deviceId } = req.deviceConfig;
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startTime = sevenDaysAgo.getTime();
    const endTime = now.getTime();

    // Sharing API may not support device logs — return empty gracefully
    if (req.tuya.isSharing) {
      try {
        const [switchData, countdownData] = await Promise.all([
          req.tuya.getDeviceLogs(deviceId, {
            start_time: startTime,
            end_time: endTime,
            size: 100,
            type: 7,
            codes: "switch_1",
          }),
          req.tuya.getDeviceLogs(deviceId, {
            start_time: startTime,
            end_time: endTime,
            size: 100,
            type: 7,
            codes: "countdown_1",
          }),
        ]);
        const switchEvents = (switchData?.logs || []).sort(
          (a, b) => a.event_time - b.event_time,
        );
        const countdownEvents = (countdownData?.logs || []).sort(
          (a, b) => a.event_time - b.event_time,
        );
        log.debug(
          `sharing: ${switchEvents.length} switch, ${countdownEvents.length} countdown`,
        );
        const countdownSetEvents = findCountdownSetEvents(countdownEvents);
        const allRuns = buildRuns(
          switchEvents,
          countdownSetEvents,
          endTime,
          deviceId,
          [],
        );
        const runs = allRuns.slice(-10);
        await resolveUserNames(runs);
        const totalSeconds = runs.reduce((sum, r) => sum + r.durationSec, 0);
        return res.json({ runs, totalSeconds });
      } catch (err) {
        log.error(`sharing logs failed: ${err.message}`);
        return res.json({ runs: [], totalSeconds: 0 });
      }
    }

    // Fetch automations + switch logs + countdown logs in parallel
    // Fetched separately so countdown ticks don't drown out switch events
    const [scheduleTimes, switchLogs, countdownLogs] = await Promise.all([
      getScheduleTimes(req.tuya, req.deviceConfig),
      fetchLogs(req.tuya, deviceId, startTime, endTime, "switch_1"),
      fetchLogs(req.tuya, deviceId, startTime, endTime, "countdown_1"),
    ]);

    const switchEvents = switchLogs.sort((a, b) => a.event_time - b.event_time);
    const countdownEvents = countdownLogs.sort(
      (a, b) => a.event_time - b.event_time,
    );

    log.debug(
      `${switchEvents.length} switch events, ${countdownEvents.length} countdown events`,
    );

    const countdownSetEvents = findCountdownSetEvents(countdownEvents);

    // Verbose debug: raw countdown events and detected "set" events
    log.debug(
      `countdown raw (last 20):`,
      countdownEvents
        .slice(-20)
        .map(
          (e) =>
            `${new Date(e.event_time).toISOString().slice(11, 19)} val=${e.value}`,
        ),
    );
    log.debug(
      `countdown SET events:`,
      countdownSetEvents.map(
        (e) =>
          `${new Date(e.event_time).toISOString().slice(11, 19)} val=${e.value}`,
      ),
    );

    const allRuns = buildRuns(
      switchEvents,
      countdownSetEvents,
      endTime,
      deviceId,
      scheduleTimes,
    );
    const runs = allRuns.slice(-10);
    await resolveUserNames(runs);
    const totalSeconds = runs.reduce((sum, r) => sum + r.durationSec, 0);

    // Summary: compact run list
    log.info(
      `${allRuns.length} runs (showing ${runs.length}): ${runs
        .map(
          (r) =>
            `${r.startTime}-${r.endTime || "now"} ${r.source}${r.userName ? " · " + r.userName : ""}`,
        )
        .join(" | ")}`,
    );
    res.json({ runs, totalSeconds });
  } catch (err) {
    log.error(`GET /history: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// Extract scheduled "HH:MM" times from automations targeting this device.
// Returns an array of { time: "HH:MM", loops: "1111111" } for matching against events.
async function getScheduleTimes(tuya, deviceConfig) {
  if (tuya.isSharing || !deviceConfig?.homeId) return [];
  try {
    const automations = await tuya.get(
      `/v1.0/homes/${deviceConfig.homeId}/automations`,
    );
    const times = [];
    for (const a of automations || []) {
      const targetsDevice = a.actions?.some(
        (act) => act.entity_id === deviceConfig.deviceId,
      );
      if (!targetsDevice) continue;
      const cond = a.conditions?.[0]?.display;
      if (cond?.time && a.enabled) {
        times.push({ time: cond.time, loops: cond.loops || "0000000" });
      }
    }
    return times;
  } catch (err) {
    log.warn(
      `Failed to fetch automations for schedule matching: ${err.message}`,
    );
    return [];
  }
}

// Check if an event timestamp matches any scheduled automation time (±2 min tolerance).
// Also checks the event falls on a day the schedule is active.
function matchesSchedule(eventTimestamp, scheduleTimes) {
  if (scheduleTimes.length === 0) return false;
  const d = new Date(eventTimestamp);
  const eventHH = d.getHours();
  const eventMM = d.getMinutes();
  const eventMin = eventHH * 60 + eventMM;
  // JS getDay: 0=Sun, convert to Mon=0..Sun=6 to match Tuya loops
  const jsDay = d.getDay();
  const tuyaDay = jsDay === 0 ? 6 : jsDay - 1;

  for (const s of scheduleTimes) {
    const [sh, sm] = s.time.split(":").map(Number);
    const schedMin = sh * 60 + sm;
    if (Math.abs(eventMin - schedMin) <= 2 && s.loops[tuyaDay] === "1") {
      return true;
    }
  }
  return false;
}

// Filter countdown events to only the "set" moments (value jumped up from previous),
// ignoring the continuous tick-down reports the device sends as countdown decrements.
function findCountdownSetEvents(countdownEvents) {
  const setEvents = [];
  for (let i = 0; i < countdownEvents.length; i++) {
    const val = parseInt(countdownEvents[i].value, 10) || 0;
    const prevVal = i > 0 ? parseInt(countdownEvents[i - 1].value, 10) || 0 : 0;
    // Value increased = a new countdown was just set
    if (val > prevVal) {
      const prevTime = i > 0 ? new Date(countdownEvents[i - 1].event_time).toISOString().slice(11, 19) : "n/a";
      const curTime = new Date(countdownEvents[i].event_time).toISOString().slice(11, 19);
      const gapMs = i > 0 ? countdownEvents[i].event_time - countdownEvents[i - 1].event_time : 0;
      log.debug(`SET detected: ${curTime} val=${val} (prev: ${prevTime} val=${prevVal}, gap=${Math.round(gapMs / 1000)}s, entry ${i}/${countdownEvents.length})`);
      setEvents.push(countdownEvents[i]);
    }
  }
  return setEvents;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtHHMM(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Classify a single log event's trigger source.
// Note: Tuya type-7 logs report event_from="1" for ALL events on this device,
// so we ignore event_from and rely on our action tracker + countdown detection.
function classifyEvent(event, deviceId) {
  const action = event.value === "true" || event.value === true ? "on" : "off";
  const ours = findOurAction(deviceId, event.event_time, action);
  if (ours) return { type: ours.type, userId: ours.userId };
  return { type: "external", userId: null };
}

// Determine the run's display source from the ON event classification + context
function determineRunSource(onSource, hasCountdown, isScheduled) {
  if (onSource === "countdown") return "quick_timer";
  if (onSource === "toggle") return "manual";
  // Schedule match takes priority over generic "external"
  if (isScheduled) return "scheduled";
  // External (not from our API): use countdown detection to narrow down
  if (hasCountdown) return "quick_timer_external";
  return "external";
}

// Batch-resolve userIds to display names, mutates runs in place
async function resolveUserNames(runs) {
  const userIds = [
    ...new Set(runs.filter((r) => r.userId).map((r) => r.userId)),
  ];
  if (userIds.length === 0) {
    for (const r of runs) delete r.userId;
    return;
  }
  try {
    const users = await clerk.users.getUserList({
      userId: userIds,
      limit: 100,
    });
    const nameMap = {};
    for (const u of users.data) {
      nameMap[u.id] =
        u.firstName || u.emailAddresses?.[0]?.emailAddress || "User";
    }
    for (const run of runs) {
      if (run.userId && nameMap[run.userId]) {
        run.userName = nameMap[run.userId];
      }
      delete run.userId;
    }
  } catch (err) {
    log.warn(`Failed to resolve user names: ${err.message}`);
    for (const r of runs) delete r.userId;
  }
}

/**
 * Find mid-run re-activations: someone started a new timer/toggle while device was already ON.
 * Merges signals from our action tracker (has userId) and countdown set events (persisted in Tuya logs).
 */
function findMidRunReactivations(
  onTime,
  offTime,
  countdownSetEvents,
  deviceId,
) {
  const reactivations = [];
  const MERGE_WINDOW = 10_000; // 10s — same event from different sources

  // From action tracker (has userId, type)
  const trackerActions = findActionsInRange(
    deviceId,
    onTime + MERGE_WINDOW,
    offTime,
  );
  for (const a of trackerActions) {
    reactivations.push({
      timestamp: a.timestamp,
      type: a.type,
      userId: a.userId,
    });
  }

  // From countdown set events (persisted in Tuya logs, survives restarts)
  for (const ce of countdownSetEvents) {
    if (ce.event_time > onTime + MERGE_WINDOW && ce.event_time < offTime) {
      const alreadyTracked = reactivations.some(
        (r) => Math.abs(r.timestamp - ce.event_time) < MERGE_WINDOW,
      );
      if (!alreadyTracked) {
        reactivations.push({
          timestamp: ce.event_time,
          type: "external",
          userId: null,
        });
      }
    }
  }

  reactivations.sort((a, b) => a.timestamp - b.timestamp);
  return reactivations;
}

function makeRun(
  startTime,
  endTime,
  endTimeIsNow,
  classification,
  hasCountdown,
  isScheduled,
  wasBlocked,
) {
  const startDate = new Date(startTime);
  const durationSec = Math.round((endTime - startTime) / 1000);
  return {
    startTime: fmtHHMM(startDate),
    endTime: endTimeIsNow ? null : fmtHHMM(new Date(endTime)),
    date: fmtDate(startDate),
    durationSec,
    source: wasBlocked
      ? "blocked"
      : determineRunSource(classification.type, hasCountdown, isScheduled),
    userId: classification.userId,
  };
}

function buildRuns(
  switchEvents,
  countdownSetEvents,
  endTime,
  deviceId,
  scheduleTimes,
) {
  const allRuns = [];
  let onEvent = null;

  for (const event of switchEvents) {
    if (event.value === "true" || event.value === true) {
      // Consecutive ON without OFF — close previous run at this ON's timestamp
      if (onEvent) {
        const onClass = classifyEvent(onEvent, deviceId);
        const hasCd = countdownSetEvents.some(
          (ce) =>
            ce.value !== "0" &&
            ce.value !== 0 &&
            Math.abs(ce.event_time - onEvent.event_time) < 5000,
        );
        const isSched =
          onClass.type === "external" &&
          matchesSchedule(onEvent.event_time, scheduleTimes);
        allRuns.push(
          makeRun(
            onEvent.event_time,
            event.event_time,
            false,
            onClass,
            hasCd,
            isSched,
            false,
          ),
        );
      }
      onEvent = event;
    } else if (onEvent) {
      // ON→OFF pair — check for mid-run re-activations to split
      const reactivations = findMidRunReactivations(
        onEvent.event_time,
        event.event_time,
        countdownSetEvents,
        deviceId,
      );

      if (reactivations.length > 0) {
        let segStart = onEvent.event_time;
        let segClass = classifyEvent(onEvent, deviceId);

        for (const react of reactivations) {
          const hasCd = countdownSetEvents.some(
            (ce) =>
              ce.value !== "0" &&
              ce.value !== 0 &&
              Math.abs(ce.event_time - segStart) < 5000,
          );
          const isSched =
            segClass.type === "external" &&
            matchesSchedule(segStart, scheduleTimes);
          allRuns.push(
            makeRun(
              segStart,
              react.timestamp,
              false,
              segClass,
              hasCd,
              isSched,
              false,
            ),
          );

          segStart = react.timestamp;
          segClass = { type: react.type, userId: react.userId };
        }

        // Final segment: last reactivation → OFF
        const offClassification = classifyEvent(event, deviceId);
        const hasCd = countdownSetEvents.some(
          (ce) =>
            ce.value !== "0" &&
            ce.value !== 0 &&
            Math.abs(ce.event_time - segStart) < 5000,
        );
        const isSched =
          segClass.type === "external" &&
          matchesSchedule(segStart, scheduleTimes);
        const wasBlocked = offClassification.type === "guard";
        allRuns.push(
          makeRun(
            segStart,
            event.event_time,
            false,
            segClass,
            hasCd,
            isSched,
            wasBlocked,
          ),
        );
      } else {
        // Normal single run
        const onClassification = classifyEvent(onEvent, deviceId);
        const offClassification = classifyEvent(event, deviceId);
        const hasCountdown = countdownSetEvents.some(
          (ce) =>
            ce.value !== "0" &&
            ce.value !== 0 &&
            Math.abs(ce.event_time - onEvent.event_time) < 5000,
        );
        const isScheduled =
          onClassification.type === "external" &&
          matchesSchedule(onEvent.event_time, scheduleTimes);
        const wasBlocked = offClassification.type === "guard";
        allRuns.push(
          makeRun(
            onEvent.event_time,
            event.event_time,
            false,
            onClassification,
            hasCountdown,
            isScheduled,
            wasBlocked,
          ),
        );
      }
      onEvent = null;
    }
  }

  // Still-running (no OFF yet)
  if (onEvent) {
    const reactivations = findMidRunReactivations(
      onEvent.event_time,
      endTime,
      countdownSetEvents,
      deviceId,
    );

    if (reactivations.length > 0) {
      let segStart = onEvent.event_time;
      let segClass = classifyEvent(onEvent, deviceId);

      for (const react of reactivations) {
        const hasCd = countdownSetEvents.some(
          (ce) =>
            ce.value !== "0" &&
            ce.value !== 0 &&
            Math.abs(ce.event_time - segStart) < 5000,
        );
        const isSched =
          segClass.type === "external" &&
          matchesSchedule(segStart, scheduleTimes);
        allRuns.push(
          makeRun(
            segStart,
            react.timestamp,
            false,
            segClass,
            hasCd,
            isSched,
            false,
          ),
        );

        segStart = react.timestamp;
        segClass = { type: react.type, userId: react.userId };
      }

      // Final segment: still running
      const hasCd = countdownSetEvents.some(
        (ce) =>
          ce.value !== "0" &&
          ce.value !== 0 &&
          Math.abs(ce.event_time - segStart) < 5000,
      );
      const isSched =
        segClass.type === "external" &&
        matchesSchedule(segStart, scheduleTimes);
      allRuns.push(
        makeRun(segStart, endTime, true, segClass, hasCd, isSched, false),
      );
    } else {
      const onClassification = classifyEvent(onEvent, deviceId);
      const hasCountdown = countdownSetEvents.some(
        (ce) =>
          ce.value !== "0" &&
          ce.value !== 0 &&
          Math.abs(ce.event_time - onEvent.event_time) < 5000,
      );
      const isScheduled =
        onClassification.type === "external" &&
        matchesSchedule(onEvent.event_time, scheduleTimes);
      allRuns.push(
        makeRun(
          onEvent.event_time,
          endTime,
          true,
          onClassification,
          hasCountdown,
          isScheduled,
          false,
        ),
      );
    }
  }

  return allRuns;
}

export default router;
