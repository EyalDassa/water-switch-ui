/**
 * SSE (Server-Sent Events) manager for pushing real-time device updates.
 *
 * - Maintains a set of connected SSE clients
 * - Polls Tuya every 60s to catch scheduled automation state changes
 * - Exports helpers for mutation routes to trigger immediate updates
 */

import { tuya, DEVICE_ID } from "./tuya.js";

// ── Connected SSE clients ───────────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

// ── Cached device status ────────────────────────────────────────────────────
let cachedStatus = { isOn: false, countdownSeconds: 0 };

async function pollStatus() {
  try {
    const dps = await tuya.get(`/v1.0/iot-03/devices/${DEVICE_ID}/status`);

    const switchDp = dps.find((dp) => dp.code === "switch_1") ?? dps.find((dp) => dp.code === "switch");
    const countdownDp = dps.find((dp) => dp.code === "countdown_1") ?? dps.find((dp) => dp.code === "countdown");

    const newStatus = {
      isOn: switchDp?.value ?? false,
      countdownSeconds: countdownDp?.value ?? 0,
    };

    const changed =
      newStatus.isOn !== cachedStatus.isOn ||
      newStatus.countdownSeconds !== cachedStatus.countdownSeconds;

    cachedStatus = newStatus;

    if (changed) {
      broadcast("status", cachedStatus);
    }
  } catch (err) {
    console.error("SSE pollStatus:", err.message);
  }
}

// ── Public helpers for mutation routes ───────────────────────────────────────

/** Call after toggle/countdown commands — waits briefly for Tuya to process, then polls + broadcasts */
export async function notifyStatusChange() {
  await new Promise((r) => setTimeout(r, 1000));
  await pollStatus();
}

/** Call after schedule CRUD — tells all connected frontends to re-fetch schedules */
export function notifySchedulesChanged() {
  broadcast("schedules-changed", {});
}

// ── SSE endpoint handler ────────────────────────────────────────────────────

export function sseHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send current cached status immediately
  res.write(`event: status\ndata: ${JSON.stringify(cachedStatus)}\n\n`);

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
}

// ── Background poll (catches scheduled automation changes) ──────────────────

export function startBackgroundPoll() {
  // Initial poll to populate cache
  pollStatus();
  // Then every 60s
  setInterval(pollStatus, 60_000);
}
