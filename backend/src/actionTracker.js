/**
 * Tracks actions initiated through our API to distinguish
 * "our UI" vs "SmartLife app" events in device history.
 *
 * In-memory ring buffer — no persistence needed.
 * Worst case after server restart: recent UI actions show as "SmartLife".
 */

const MAX_ENTRIES = 500;
const entries = [];

/**
 * Record an action from our API.
 * @param {string} deviceId
 * @param {"toggle"|"countdown"} type
 * @param {"on"|"off"} action
 * @param {string|null} [userId]
 */
export function recordAction(deviceId, type, action, userId = null) {
  entries.push({ deviceId, type, action, timestamp: Date.now(), userId });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

/**
 * Check if a cloud event at the given timestamp was initiated by our UI.
 * Uses ±10s window to account for Tuya processing delay.
 *
 * @param {string} deviceId
 * @param {number} eventTimestamp - millisecond timestamp from Tuya log
 * @param {string} action - "on" or "off"
 * @returns {{ type: "toggle"|"countdown", userId: string|null } | null}
 */
/**
 * Check if we recently toggled a device (for activation guard).
 * Uses a wider window than findOurAction since polling may detect
 * the change up to 60-120s after we sent the command.
 */
export function wasRecentlyToggledByUs(deviceId, action = "on", windowMs = 120_000) {
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (now - e.timestamp > windowMs) break;
    if (e.deviceId === deviceId && e.action === action) return true;
  }
  return false;
}

/**
 * Find all our "on" actions within a time range (for splitting overlapping runs).
 */
export function findActionsInRange(deviceId, startTime, endTime, action = "on") {
  const results = [];
  for (const e of entries) {
    if (e.deviceId === deviceId && e.action === action && e.timestamp > startTime && e.timestamp < endTime) {
      results.push(e);
    }
  }
  return results;
}

export function findOurAction(deviceId, eventTimestamp, action) {
  const WINDOW_MS = 10_000;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.deviceId === deviceId && e.action === action && Math.abs(e.timestamp - eventTimestamp) < WINDOW_MS) {
      return { type: e.type, userId: e.userId };
    }
    if (eventTimestamp - e.timestamp > 60_000) break;
  }
  return null;
}
