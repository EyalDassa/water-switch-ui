/**
 * SSE (Server-Sent Events) manager with per-device client groups.
 *
 * - Maintains a Map of deviceId → { clients, cachedStatus }
 * - Status updates come from Tuya Pulsar push (no polling)
 * - handlePulsarStatus() is called by server.js when a push arrives
 * - Initial status fetched once on SSE connect
 */

import { isGuardEnabled, startGuard, refreshSchedules as refreshGuardSchedules } from "./activationGuard.js";
import { createClerkClient } from "@clerk/express";
import { createLogger } from "./logger.js";

const log = createLogger("sse");

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── Per-device client registry ──────────────────────────────────────────────
// Map<deviceId, { clients: Set<res>, tuyaClient: TuyaClient, cachedStatus }>
const deviceGroups = new Map();

function getOrCreateGroup(deviceId, tuyaClient) {
  if (!deviceGroups.has(deviceId)) {
    deviceGroups.set(deviceId, {
      clients: new Set(),
      tuyaClient,
      cachedStatus: { isOn: false, countdownSeconds: 0, online: true },
    });
  }
  const group = deviceGroups.get(deviceId);
  if (tuyaClient) group.tuyaClient = tuyaClient;
  return group;
}

function broadcastToDevice(deviceId, event, data) {
  const group = deviceGroups.get(deviceId);
  if (!group) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of group.clients) {
    res.write(msg);
  }
}

// ── Pulsar push handler (called from server.js) ─────────────────────────────

/**
 * Handle a device status push from Tuya Pulsar.
 * @param {string} deviceId
 * @param {Array<{code: string, value: any}>} dps - data points from push
 */
export function handlePulsarStatus(deviceId, dps) {
  const group = deviceGroups.get(deviceId);
  if (!group) return;

  const switchDp = dps.find((dp) => dp.code === "switch_1") ?? dps.find((dp) => dp.code === "switch");
  const countdownDp = dps.find((dp) => dp.code === "countdown_1") ?? dps.find((dp) => dp.code === "countdown");

  // Pulsar pushes only changed DPs, so merge with cached
  const prev = group.cachedStatus;
  const newStatus = {
    isOn: switchDp ? switchDp.value : prev.isOn,
    countdownSeconds: countdownDp ? countdownDp.value : prev.countdownSeconds,
    online: true, // receiving a push means device is online
  };

  const changed =
    newStatus.isOn !== prev.isOn ||
    newStatus.countdownSeconds !== prev.countdownSeconds ||
    newStatus.online !== prev.online;

  group.cachedStatus = newStatus;

  if (changed) {
    const dev = deviceId.slice(0, 8);
    if (newStatus.isOn !== prev.isOn) {
      log.event(`Device ${dev}… turned ${newStatus.isOn ? "ON" : "OFF"} (push)`);
    }
    if (newStatus.countdownSeconds !== prev.countdownSeconds && (newStatus.countdownSeconds > 0 || prev.countdownSeconds > 0)) {
      log.event(`Device ${dev}… countdown: ${prev.countdownSeconds}s → ${newStatus.countdownSeconds}s`);
    }
    if (newStatus.online !== prev.online) {
      log.event(`Device ${dev}… went online (push)`);
    }
    broadcastToDevice(deviceId, "status", newStatus);
  }
}

// ── One-time status fetch (on SSE connect) ──────────────────────────────────

async function fetchAndBroadcastStatus(deviceId) {
  const group = deviceGroups.get(deviceId);
  if (!group) return;

  try {
    let dps;
    let online = true;
    if (group.tuyaClient.isSharing) {
      const [statusResult, infoResult] = await Promise.all([
        group.tuyaClient.getDeviceStatus(deviceId),
        group.tuyaClient.getDeviceInfo(deviceId).catch(() => null),
      ]);
      dps = Array.isArray(statusResult) ? statusResult : statusResult?.status || statusResult?.dpStatusRelationDTOS || [];
      if (infoResult) online = infoResult.online ?? infoResult.isOnline ?? true;
    } else {
      const [statusResult, infoResult] = await Promise.all([
        group.tuyaClient.get(`/v1.0/iot-03/devices/${deviceId}/status`),
        group.tuyaClient.get(`/v1.0/devices/${deviceId}`).catch(() => null),
      ]);
      dps = statusResult;
      if (infoResult) online = infoResult.online ?? true;
    }

    const switchDp = dps.find((dp) => dp.code === "switch_1") ?? dps.find((dp) => dp.code === "switch");
    const countdownDp = dps.find((dp) => dp.code === "countdown_1") ?? dps.find((dp) => dp.code === "countdown");

    const newStatus = {
      isOn: switchDp?.value ?? false,
      countdownSeconds: countdownDp?.value ?? 0,
      online,
    };

    group.cachedStatus = newStatus;
    broadcastToDevice(deviceId, "status", newStatus);
  } catch (err) {
    log.error(`fetchStatus(${deviceId.slice(0, 8)}…): ${err.message}`);
  }
}

// ── Public helpers for mutation routes ───────────────────────────────────────

/** Call after toggle/countdown — Pulsar push will broadcast to SSE clients */
export async function notifyStatusChange(deviceId, tuyaClient) {
  if (tuyaClient) getOrCreateGroup(deviceId, tuyaClient);
}

/** Call after schedule CRUD — tells connected frontends for this device to re-fetch */
export function notifySchedulesChanged(deviceId) {
  broadcastToDevice(deviceId, "schedules-changed", {});
  refreshGuardSchedules(deviceId);
}

// ── SSE endpoint handler ────────────────────────────────────────────────────

export function sseHandler(req, res) {
  const deviceId = req.deviceConfig?.deviceId;
  if (!deviceId) {
    return res.status(412).json({ error: "no_device" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const group = getOrCreateGroup(deviceId, req.tuya);

  // Send cached status immediately, then fetch fresh status from Tuya
  res.write(`event: status\ndata: ${JSON.stringify(group.cachedStatus)}\n\n`);
  fetchAndBroadcastStatus(deviceId).catch((err) => log.error(`Initial fetch failed: ${err.message}`));

  group.clients.add(res);

  // Initialize activation guard if the admin has it enabled
  if (!isGuardEnabled(deviceId)) {
    initGuardIfEnabled(deviceId, req.deviceConfig);
  }

  req.on("close", () => {
    group.clients.delete(res);
    if (group.clients.size === 0) {
      deviceGroups.delete(deviceId);
    }
  });
}

// ── Guard initialization ───────────────────────────────────────────────────

async function initGuardIfEnabled(deviceId, deviceConfig) {
  try {
    const adminUserId = deviceConfig?.adminUserId || deviceConfig?.userId;
    if (!adminUserId) return;

    const admin = await clerk.users.getUser(adminUserId);
    const settings = admin.publicMetadata?.settings;
    if (settings?.blockExternalActivations) {
      startGuard(deviceId, adminUserId, "immediate");
    } else if (settings?.blockAfterOneHour) {
      const delayMs = ((settings.guardMaxMinutes || 60) * 60 + 30) * 1000;
      startGuard(deviceId, adminUserId, "delayed", delayMs);
    }
  } catch (err) {
    log.warn(`Failed to check guard setting: ${err.message}`);
  }
}

// ── No-op (polling removed — Pulsar provides updates) ────────────────────────

export function startBackgroundPoll() {
  log.info("Pulsar push mode active — no polling needed.");
}
