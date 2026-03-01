import { Router } from "express";
import { tuya, DEVICE_ID } from "../tuya.js";
import { notifyStatusChange } from "../events.js";

const router = Router();

// GET /api/status
router.get("/status", async (req, res) => {
  try {
    const dps = await tuya.get(`/v1.0/iot-03/devices/${DEVICE_ID}/status`);

    const switchDp = dps.find((dp) => dp.code === "switch_1") ?? dps.find((dp) => dp.code === "switch");
    const countdownDp = dps.find((dp) => dp.code === "countdown_1") ?? dps.find((dp) => dp.code === "countdown");

    res.json({
      isOn: switchDp?.value ?? false,
      countdownSeconds: countdownDp?.value ?? 0,
      rawDps: dps,
    });
  } catch (err) {
    console.error("GET /status:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/toggle  { action: "on" | "off" }
router.post("/toggle", async (req, res) => {
  const { action } = req.body;
  if (action !== "on" && action !== "off") {
    return res.status(400).json({ error: 'action must be "on" or "off"' });
  }

  const value = action === "on";

  try {
    await tuya.post(`/v1.0/iot-03/devices/${DEVICE_ID}/commands`, {
      commands: [{ code: "switch_1", value }],
    });
    res.json({ success: true, isOn: value });
    notifyStatusChange();
  } catch (firstErr) {
    // Fallback to legacy "switch" DP code
    try {
      await tuya.post(`/v1.0/iot-03/devices/${DEVICE_ID}/commands`, {
        commands: [{ code: "switch", value }],
      });
      res.json({ success: true, isOn: value });
      notifyStatusChange();
    } catch (err) {
      console.error("POST /toggle:", err.message);
      res.status(502).json({ error: err.message });
    }
  }
});

// GET /api/history — 10 most recent ON/OFF run sessions from Tuya device logs
// Looks back up to 7 days to find enough runs.
router.get("/history", async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startTime = sevenDaysAgo.getTime();
    const endTime = now.getTime();

    // Fetch only switch_1 events using codes filter — avoids countdown_1 noise
    // that otherwise fills every page. Tuya duplicates across pages, so deduplicate.
    const seen = new Set();
    const switchEvents = [];
    let lastRowKey = "";
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rowKeyParam = lastRowKey ? `&last_row_key=${encodeURIComponent(lastRowKey)}` : "";
      const data = await tuya.get(
        `/v1.0/devices/${DEVICE_ID}/logs?start_time=${startTime}&end_time=${endTime}&size=100&type=7&codes=switch_1${rowKeyParam}`
      );

      const logs = data.logs || [];
      for (const log of logs) {
        const key = `${log.event_time}_${log.value}`;
        if (!seen.has(key)) {
          seen.add(key);
          switchEvents.push(log);
        }
      }

      if (!data.has_next || !data.next_row_key) break;
      lastRowKey = data.next_row_key;
    }

    // Sort chronologically
    switchEvents.sort((a, b) => a.event_time - b.event_time);

    function fmtDate(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // Pair ON→OFF into run sessions
    const allRuns = [];
    let onEvent = null;

    for (const event of switchEvents) {
      if (event.value === "true" || event.value === true) {
        onEvent = event;
      } else if (onEvent) {
        const startDate = new Date(onEvent.event_time);
        const durationSec = Math.round((event.event_time - onEvent.event_time) / 1000);
        allRuns.push({
          startTime: `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`,
          endTime: `${String(new Date(event.event_time).getHours()).padStart(2, "0")}:${String(new Date(event.event_time).getMinutes()).padStart(2, "0")}`,
          date: fmtDate(startDate),
          durationSec,
        });
        onEvent = null;
      }
    }

    // If currently ON (last event was ON with no OFF), include ongoing run
    if (onEvent) {
      const startDate = new Date(onEvent.event_time);
      const durationSec = Math.round((endTime - onEvent.event_time) / 1000);
      allRuns.push({
        startTime: `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`,
        endTime: null,
        date: fmtDate(startDate),
        durationSec,
      });
    }

    // Return the 10 most recent runs
    const runs = allRuns.slice(-10);
    const totalSeconds = runs.reduce((sum, r) => sum + r.durationSec, 0);

    res.json({ runs, totalSeconds });
  } catch (err) {
    console.error("GET /history:", err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
