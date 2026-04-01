/**
 * Activation Guard — enforces max run time on ALL device activations.
 *
 * Push-based: triggered by Tuya Pulsar status pushes (no polling).
 * - Immediate mode: blocks external (non-app, non-scheduled) activations instantly
 * - Delayed mode: allows any activation but enforces a max run time (1h30s)
 *   using setTimeout — precise to the millisecond, zero API calls while waiting.
 */

import { defaultClient as tuya } from "./tuya.js";
import { wasRecentlyToggledByUs, recordAction } from "./actionTracker.js";
import { createClerkClient } from "@clerk/express";
import { createLogger } from "./logger.js";

const log = createLogger("guard");

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── In-memory state ────────────────────────────────────────────────────────
// deviceId → { mode, adminUserId, scheduleTimes, lastKnownOn, onSince, delayedTimeout }
const guardedDevices = new Map();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@parligator.com";
if (RESEND_API_KEY) {
  log.info("Resend configured — email notifications enabled");
} else {
  log.info("No RESEND_API_KEY — email notifications disabled");
}

// ── Public API ─────────────────────────────────────────────────────────────

export function isGuardEnabled(deviceId) {
  return guardedDevices.has(deviceId);
}

export function startGuard(deviceId, adminUserId, mode = "immediate") {
  const existing = guardedDevices.get(deviceId);
  if (existing) {
    existing.mode = mode;
    return;
  }

  const guard = {
    mode,
    adminUserId,
    scheduleTimes: [],
    lastKnownOn: false,
    onSince: null,
    delayedTimeout: null,
  };
  guardedDevices.set(deviceId, guard);

  refreshSchedules(deviceId);
  log.info(`Started for device ${deviceId.slice(0, 8)}… (mode: ${mode})`);
}

export function stopGuard(deviceId) {
  const guard = guardedDevices.get(deviceId);
  if (!guard) return;
  if (guard.delayedTimeout) clearTimeout(guard.delayedTimeout);
  guardedDevices.delete(deviceId);
  log.info(`Stopped for device ${deviceId.slice(0, 8)}…`);
}

/** Re-cache schedule times (call after schedule CRUD) */
export async function refreshSchedules(deviceId) {
  const guard = guardedDevices.get(deviceId);
  if (!guard) return;

  const homeId = process.env.HOME_ID;
  if (!homeId) return;

  try {
    const automations = await tuya.get(`/v1.0/homes/${homeId}/automations`);
    const times = [];
    for (const a of automations || []) {
      const targetsDevice = a.actions?.some((act) => act.entity_id === deviceId);
      if (!targetsDevice) continue;
      const cond = a.conditions?.[0]?.display;
      if (cond?.time && a.enabled) {
        times.push({ time: cond.time, loops: cond.loops || "0000000" });
      }
    }
    guard.scheduleTimes = times;
  } catch (err) {
    log.warn(`Failed to refresh schedules: ${err.message}`);
  }
}

// ── Pulsar push handler (called from server.js) ─────────────────────────────

const DELAYED_BLOCK_MS = (60 * 60 + 30) * 1000; // 1 hour 30 seconds

/**
 * Handle a device status push from Tuya Pulsar.
 * @param {string} deviceId
 * @param {Array<{code: string, value: any}>} dps
 */
export function handlePulsarStatus(deviceId, dps) {
  const guard = guardedDevices.get(deviceId);
  if (!guard) return;

  const switchDp =
    dps.find((dp) => dp.code === "switch_1") ??
    dps.find((dp) => dp.code === "switch");

  // Only react to switch state changes
  if (!switchDp) return;

  const isOn = switchDp.value;
  const wasOff = !guard.lastKnownOn;
  guard.lastKnownOn = isOn;

  // ── Device turned OFF → clear any pending timeout ──────────────────
  if (!isOn) {
    if (guard.delayedTimeout) {
      clearTimeout(guard.delayedTimeout);
      guard.delayedTimeout = null;
    }
    guard.onSince = null;
    return;
  }

  // ── Device turned ON (transition from OFF → ON) ────────────────────
  if (!wasOff) return; // already ON, ignore repeated pushes

  // Was it triggered by our API?
  if (wasRecentlyToggledByUs(deviceId, "on")) {
    guard.onSince = null;
    // In delayed mode, still enforce max run time even for our own activations
    if (guard.mode === "delayed") {
      scheduleDelayedBlock(deviceId, guard);
    }
    return;
  }

  // Does it match a schedule?
  if (matchesSchedule(Date.now(), guard.scheduleTimes)) {
    guard.onSince = null;
    // In delayed mode, still enforce max run time even for scheduled activations
    if (guard.mode === "delayed") {
      scheduleDelayedBlock(deviceId, guard);
    }
    return;
  }

  // ── Immediate mode: block on first detection ───────────────────────
  if (guard.mode === "immediate") {
    log.event(`BLOCKING external activation on ${deviceId.slice(0, 8)}… (immediate mode)`);
    turnOff(deviceId).then(() => {
      recordAction(deviceId, "guard", "off");
      guard.lastKnownOn = false;
      guard.onSince = null;
      sendNotification(deviceId, guard);
    }).catch((err) => log.error(`Failed to block activation: ${err.message}`));
    return;
  }

  // ── Delayed mode: allow but enforce max run time ───────────────────
  if (guard.mode === "delayed") {
    log.event(`External activation detected on ${deviceId.slice(0, 8)}…, will block after 1h`);
    guard.onSince = Date.now();
    scheduleDelayedBlock(deviceId, guard);
  }
}

function scheduleDelayedBlock(deviceId, guard) {
  // Clear any existing timeout
  if (guard.delayedTimeout) clearTimeout(guard.delayedTimeout);

  guard.delayedTimeout = setTimeout(async () => {
    guard.delayedTimeout = null;
    if (!guard.lastKnownOn) return;

    try {
      log.event(`BLOCKING activation (exceeded 1h) on ${deviceId.slice(0, 8)}…`);
      await turnOff(deviceId);
      recordAction(deviceId, "guard", "off");
      guard.lastKnownOn = false;
      guard.onSince = null;
      sendNotification(deviceId, guard);
    } catch (err) {
      log.error(`Failed to block delayed activation: ${err.message}`);
    }
  }, DELAYED_BLOCK_MS);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function matchesSchedule(timestamp, scheduleTimes) {
  if (!scheduleTimes || scheduleTimes.length === 0) return false;
  const d = new Date(timestamp);
  const eventMin = d.getHours() * 60 + d.getMinutes();
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

async function turnOff(deviceId) {
  try {
    await tuya.post(`/v1.0/iot-03/devices/${deviceId}/commands`, {
      commands: [{ code: "switch_1", value: false }],
    });
  } catch {
    await tuya.post(`/v1.0/iot-03/devices/${deviceId}/commands`, {
      commands: [{ code: "switch", value: false }],
    });
  }
}

async function sendNotification(deviceId, guard) {
  try {
    const admin = await clerk.users.getUser(guard.adminUserId);
    const adminPub = admin.publicMetadata || {};
    const deviceName = adminPub.deviceName || "Water Boiler";
    const adminEmail = admin.emailAddresses?.[0]?.emailAddress;

    const time = new Date().toLocaleTimeString("en-IL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jerusalem",
    });

    log.event(`Blocked external activation on "${deviceName}" at ${time}. Notifying: ${adminEmail || "(no email)"}`);

    if (!RESEND_API_KEY || !adminEmail) return;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${deviceName} <${EMAIL_FROM}>`,
        to: [adminEmail],
        subject: `${deviceName} — External activation blocked`,
        text: [
          `An external activation was detected on "${deviceName}" at ${time} and was automatically blocked.`,
          "",
          "This usually means a power spike, dust on the switch, or someone using the SmartLife app directly.",
          "",
          "The device was immediately turned back off.",
          "",
          "You can disable this protection in Settings > Block External Activations.",
        ].join("\n"),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log.warn("Resend API error:", err);
    }
  } catch (err) {
    log.warn(`Notification error: ${err.message}`);
  }
}
