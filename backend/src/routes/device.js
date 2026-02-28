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

// GET /api/history — today's ON/OFF run sessions from Tuya device logs
// Paginates through all logs for today (countdown_1 events every 30s can fill pages)
router.get("/history", async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startTime = startOfDay.getTime();
    const endTime = now.getTime();

    // Fetch switch_1 events for today, paginating through countdown noise.
    // Tuya duplicates events across pages, so we deduplicate by event_time+value.
    const seen = new Set();
    const switchEvents = [];
    let lastRowKey = "";
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rowKeyParam = lastRowKey ? `&last_row_key=${encodeURIComponent(lastRowKey)}` : "";
      const data = await tuya.get(
        `/v1.0/devices/${DEVICE_ID}/logs?start_time=${startTime}&end_time=${endTime}&size=100&type=7${rowKeyParam}`
      );

      const logs = data.logs || [];
      for (const log of logs) {
        if (log.code === "switch_1") {
          const key = `${log.event_time}_${log.value}`;
          if (!seen.has(key)) {
            seen.add(key);
            switchEvents.push(log);
          }
        }
      }

      if (!data.has_next || !data.next_row_key) break;
      lastRowKey = data.next_row_key;
    }

    // Sort chronologically
    switchEvents.sort((a, b) => a.event_time - b.event_time);

    // Pair ON→OFF into run sessions
    const runs = [];
    let onEvent = null;

    for (const event of switchEvents) {
      if (event.value === "true" || event.value === true) {
        onEvent = event;
      } else if (onEvent) {
        const startDate = new Date(onEvent.event_time);
        const endDate = new Date(event.event_time);
        const durationSec = Math.round((event.event_time - onEvent.event_time) / 1000);
        runs.push({
          startTime: `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`,
          endTime: `${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`,
          durationSec,
        });
        onEvent = null;
      }
    }

    // If currently ON (last event was ON with no OFF), include ongoing run
    if (onEvent) {
      const startDate = new Date(onEvent.event_time);
      const durationSec = Math.round((endTime - onEvent.event_time) / 1000);
      runs.push({
        startTime: `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`,
        endTime: null, // still running
        durationSec,
      });
    }

    const totalSeconds = runs.reduce((sum, r) => sum + r.durationSec, 0);

    res.json({ runs, totalSeconds });
  } catch (err) {
    console.error("GET /history:", err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
