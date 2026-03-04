import { Router } from "express";
import { notifyStatusChange, notifySchedulesChanged } from "../events.js";
import { recordAction } from "../actionTracker.js";

const router = Router();

const AUTOMATION_BG = "https://images.tuyaeu.com/smart/rule/cover/place2.png";

// ── Day helpers ──────────────────────────────────────────────────────────────
// Tuya loops: 7-char string, position 0=Mon … 6=Sun, "1"=active
// Frontend days: ["daily"] | ["weekdays"] | ["weekends"] | ["mon","tue",…]
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function daysToLoops(days) {
  if (days.includes("daily")) return "1111111";
  if (days.includes("weekdays")) return "1111100";
  if (days.includes("weekends")) return "0000011";
  return DAY_ORDER.map((d) => (days.includes(d) ? "1" : "0")).join("");
}

function loopsToDays(loops) {
  if (loops === "1111111") return ["daily"];
  if (loops === "1111100") return ["weekdays"];
  if (loops === "0000011") return ["weekends"];
  return DAY_ORDER.filter((_, i) => loops[i] === "1");
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function addMinutes(time, mins) {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + mins) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function diffMinutes(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff > 0 ? diff : diff + 24 * 60;
}

// ── Color index encoding in automation name ─────────────────────────────────
// Format: "Schedule Name[c:3]" — suffix stripped for display, parsed for colorIndex
function encodeColorInName(name, colorIndex) {
  if (colorIndex == null) return name;
  return `${name}[c:${colorIndex}]`;
}

function decodeColorFromName(rawName) {
  const match = rawName?.match(/^(.*?)\[c:(\d+)\]$/);
  if (match) return { name: match[1], colorIndex: parseInt(match[2], 10) };
  return { name: rawName, colorIndex: undefined };
}

// ── Parse a Tuya automation into our schedule shape ──────────────────────────
function parseAutomation(a, deviceId) {
  const cond = a.conditions?.[0]?.display;
  if (!cond) return null;

  const countdownAction = a.actions?.find(
    (act) => act.executor_property?.countdown_1 != null
  );
  const countdownSec = countdownAction?.executor_property?.countdown_1 || 0;
  const startTime = cond.time; // "HH:MM"
  const endTime = addMinutes(startTime, Math.round(countdownSec / 60));
  const days = loopsToDays(cond.loops || "0000000");
  const { name, colorIndex } = decodeColorFromName(a.name);

  return {
    id: a.automation_id,
    name,
    colorIndex,
    isEnabled: a.enabled,
    startTime,
    endTime,
    durationMinutes: Math.round(countdownSec / 60),
    days,
  };
}

// GET /api/schedules
router.get("/schedules", async (req, res) => {
  const { deviceId, homeId } = req.deviceConfig;

  // Sharing API doesn't support automation CRUD — return empty for now
  if (req.tuya.isSharing) {
    return res.json({ schedules: [] });
  }

  try {
    const automations = await req.tuya.get(`/v1.0/homes/${homeId}/automations`);
    // Only include automations that target our device
    const ours = automations
      .filter((a) =>
        a.actions?.some((act) => act.entity_id === deviceId)
      )
      .map((a) => parseAutomation(a, deviceId))
      .filter(Boolean);

    // Return in the on/off pair format the frontend expects
    const schedules = ours.flatMap((s) => [
      { id: s.id + ":on",  groupId: s.id, name: s.name, colorIndex: s.colorIndex, isEnabled: s.isEnabled, time: s.startTime, days: s.days, action: "on" },
      { id: s.id + ":off", groupId: s.id, name: s.name, colorIndex: s.colorIndex, isEnabled: s.isEnabled, time: s.endTime,   days: s.days, action: "off" },
    ]);
    res.json({ schedules });
  } catch (err) {
    console.error("GET /schedules:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/schedules  { name?, startTime, endTime, days }
router.post("/schedules", async (req, res) => {
  if (req.tuya.isSharing) {
    return res.status(501).json({ error: "Schedule creation not yet supported for shared devices" });
  }
  const { deviceId, homeId } = req.deviceConfig;
  const { name, startTime, endTime, days = ["daily"], colorIndex } = req.body;
  if (!startTime || !endTime) {
    return res.status(400).json({ error: "startTime and endTime required (HH:MM)" });
  }

  const durationMin = diffMinutes(startTime, endTime);
  const countdownSec = durationMin * 60;
  const loops = daysToLoops(days);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const displayName = name || `Water ${startTime} (${durationMin}m)`;

  try {
    const automationId = await req.tuya.post(`/v1.0/homes/${homeId}/automations`, {
      name: encodeColorInName(displayName, colorIndex),
      background: AUTOMATION_BG,
      conditions: [{
        display: {
          date: today,
          loops,
          time: startTime,
          timezone_id: "Asia/Jerusalem",
        },
        entity_id: "timer",
        entity_type: 6,
        order_num: 1,
      }],
      actions: [
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { switch_1: true } },
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { countdown_1: countdownSec } },
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { relay_status: "power_off" } },
      ],
      match_type: 1,
      preconditions: [],
    });
    res.json({ success: true, id: automationId });
    notifySchedulesChanged(deviceId);
  } catch (err) {
    console.error("POST /schedules:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// PUT /api/schedules/:id  { name, startTime, endTime, days }
router.put("/schedules/:id", async (req, res) => {
  if (req.tuya.isSharing) {
    return res.status(501).json({ error: "Schedule editing not yet supported for shared devices" });
  }
  const { deviceId, homeId } = req.deviceConfig;
  const autoId = req.params.id.replace(/:on$|:off$/, "");
  const { name, startTime, endTime, days = ["daily"], colorIndex } = req.body;
  if (!startTime || !endTime) {
    return res.status(400).json({ error: "startTime and endTime required (HH:MM)" });
  }

  const durationMin = diffMinutes(startTime, endTime);
  const countdownSec = durationMin * 60;
  const loops = daysToLoops(days);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const displayName = name || `Water ${startTime} (${durationMin}m)`;

  try {
    await req.tuya.put(`/v1.0/homes/${homeId}/automations/${autoId}`, {
      name: encodeColorInName(displayName, colorIndex),
      background: AUTOMATION_BG,
      conditions: [{
        display: {
          date: today,
          loops,
          time: startTime,
          timezone_id: "Asia/Jerusalem",
        },
        entity_id: "timer",
        entity_type: 6,
        order_num: 1,
      }],
      actions: [
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { switch_1: true } },
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { countdown_1: countdownSec } },
        { action_executor: "dpIssue", entity_id: deviceId, executor_property: { relay_status: "power_off" } },
      ],
      match_type: 1,
      preconditions: [],
    });
    res.json({ success: true });
    notifySchedulesChanged(deviceId);
  } catch (err) {
    console.error("PUT /schedules:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id
router.delete("/schedules/:id", async (req, res) => {
  if (req.tuya.isSharing) {
    return res.status(501).json({ error: "Schedule deletion not yet supported for shared devices" });
  }
  const { homeId, deviceId } = req.deviceConfig;
  const autoId = req.params.id.replace(/:on$|:off$/, "");
  try {
    await req.tuya.delete(`/v1.0/homes/${homeId}/automations/${autoId}`);
    res.json({ success: true });
    notifySchedulesChanged(deviceId);
  } catch (err) {
    console.error("DELETE /schedules:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// PUT /api/schedules/:id/enable
router.put("/schedules/:id/enable", async (req, res) => {
  if (req.tuya.isSharing) {
    return res.status(501).json({ error: "Not supported for shared devices" });
  }
  const { homeId, deviceId } = req.deviceConfig;
  const autoId = req.params.id.replace(/:on$|:off$/, "");
  try {
    await req.tuya.put(`/v1.0/homes/${homeId}/automations/${autoId}/actions/enable`);
    res.json({ success: true });
    notifySchedulesChanged(deviceId);
  } catch (err) {
    console.error("PUT /schedules enable:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// PUT /api/schedules/:id/disable
router.put("/schedules/:id/disable", async (req, res) => {
  if (req.tuya.isSharing) {
    return res.status(501).json({ error: "Not supported for shared devices" });
  }
  const { homeId, deviceId } = req.deviceConfig;
  const autoId = req.params.id.replace(/:on$|:off$/, "");
  try {
    await req.tuya.put(`/v1.0/homes/${homeId}/automations/${autoId}/actions/disable`);
    res.json({ success: true });
    notifySchedulesChanged(deviceId);
  } catch (err) {
    console.error("PUT /schedules disable:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/countdown  { minutes }
router.post("/countdown", async (req, res) => {
  const { deviceId } = req.deviceConfig;
  const { minutes } = req.body;
  if (!minutes || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ error: "minutes must be 1-1440" });
  }
  const seconds = Math.round(minutes * 60);
  try {
    if (req.tuya.isSharing) {
      await req.tuya.sendCommands(deviceId, [
        { code: "switch_1", value: true },
        { code: "countdown_1", value: seconds },
      ]);
    } else {
      await req.tuya.post(`/v1.0/iot-03/devices/${deviceId}/commands`, {
        commands: [
          { code: "switch_1", value: true },
          { code: "countdown_1", value: seconds },
        ],
      });
    }
    recordAction(deviceId, "countdown", "on", req.deviceConfig.userId);
    res.json({ success: true, countdownSeconds: seconds });
    notifyStatusChange(deviceId, req.tuya);
  } catch (err) {
    console.error("POST /countdown:", err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
