/**
 * SSE (Server-Sent Events) manager with per-device client groups.
 *
 * - Maintains a Map of deviceId → { clients, cachedStatus, pollInterval }
 * - Only polls devices that have active SSE connections
 * - Stops polling when all clients for a device disconnect
 */

import { isGuardEnabled, startGuard, refreshSchedules as refreshGuardSchedules } from "./activationGuard.js";
import { createClerkClient } from "@clerk/express";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── Per-device client registry ──────────────────────────────────────────────
// Map<deviceId, { clients: Set<res>, tuyaClient: TuyaClient, cachedStatus, pollInterval }>
const deviceGroups = new Map();

function getOrCreateGroup(deviceId, tuyaClient) {
  if (!deviceGroups.has(deviceId)) {
    deviceGroups.set(deviceId, {
      clients: new Set(),
      tuyaClient,
      cachedStatus: { isOn: false, countdownSeconds: 0, online: true },
      pollInterval: null,
    });
  }
  const group = deviceGroups.get(deviceId);
  // Update tuyaClient if a newer one is provided
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

async function pollDeviceStatus(deviceId) {
  const group = deviceGroups.get(deviceId);
  if (!group || group.clients.size === 0) return;

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

    const changed =
      newStatus.isOn !== group.cachedStatus.isOn ||
      newStatus.countdownSeconds !== group.cachedStatus.countdownSeconds ||
      newStatus.online !== group.cachedStatus.online;

    group.cachedStatus = newStatus;

    if (changed) {
      broadcastToDevice(deviceId, "status", newStatus);
    }
  } catch (err) {
    console.error(`[sse] pollStatus(${deviceId}):`, err.message);
  }
}

function startPollingDevice(deviceId) {
  const group = deviceGroups.get(deviceId);
  if (!group || group.pollInterval) return;

  pollDeviceStatus(deviceId);
  group.pollInterval = setInterval(() => pollDeviceStatus(deviceId), 8_000);
  console.log(`[sse] Started polling device ${deviceId.slice(0, 8)}...`);
}

function stopPollingDevice(deviceId) {
  const group = deviceGroups.get(deviceId);
  if (!group) return;

  if (group.pollInterval) {
    clearInterval(group.pollInterval);
    group.pollInterval = null;
    console.log(`[sse] Stopped polling device ${deviceId.slice(0, 8)}...`);
  }

  if (group.clients.size === 0) {
    deviceGroups.delete(deviceId);
  }
}

// ── Public helpers for mutation routes ───────────────────────────────────────

/** Call after toggle/countdown — waits briefly for Tuya to process, then polls + broadcasts */
export async function notifyStatusChange(deviceId, tuyaClient) {
  if (tuyaClient) getOrCreateGroup(deviceId, tuyaClient);
  await new Promise((r) => setTimeout(r, 1000));
  await pollDeviceStatus(deviceId);
}

/** Call after schedule CRUD — tells connected frontends for this device to re-fetch */
export function notifySchedulesChanged(deviceId) {
  broadcastToDevice(deviceId, "schedules-changed", {});
  // Keep guard schedule cache in sync
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

  // Send cached status immediately
  res.write(`event: status\ndata: ${JSON.stringify(group.cachedStatus)}\n\n`);

  group.clients.add(res);
  startPollingDevice(deviceId);

  // Initialize activation guard if the admin has it enabled
  if (!isGuardEnabled(deviceId)) {
    initGuardIfEnabled(deviceId, req.deviceConfig);
  }

  req.on("close", () => {
    group.clients.delete(res);
    if (group.clients.size === 0) {
      stopPollingDevice(deviceId);
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
      startGuard(deviceId, adminUserId, "delayed");
    }
  } catch (err) {
    console.warn("[sse] Failed to check guard setting:", err.message);
  }
}

// ── Background poll (no-op in per-device mode) ──────────────────────────────

export function startBackgroundPoll() {
  console.log("[sse] Per-device polling mode active. Polling starts on SSE connect.");
}
