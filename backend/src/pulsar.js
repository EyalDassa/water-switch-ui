/**
 * Tuya Pulsar WebSocket client — receives real-time device status push messages.
 *
 * Replaces polling: Tuya pushes device status changes (switch ON/OFF, countdown, etc.)
 * via a persistent WebSocket connection using their Pulsar message service.
 *
 * Protocol (from official tuya-pulsar-ws-node SDK):
 * - WebSocket to wss://mqe.tuya{region}.com:8285/
 * - Auth headers: username = ACCESS_ID, password = md5(ACCESS_ID + md5(ACCESS_SECRET))[8:24]
 * - Payload: base64 → JSON → data field is AES-128-ECB encrypted with ACCESS_SECRET[8:24]
 * - Must ACK each message by sending { messageId } back
 */

import { createHash, createDecipheriv } from "crypto";
import WebSocket from "ws";
import { createLogger } from "./logger.js";

const log = createLogger("pulsar");

const REGION_ENDPOINTS = {
  us: "wss://mqe.tuyaus.com:8285/",
  eu: "wss://mqe.tuyaeu.com:8285/",
  cn: "wss://mqe.tuyacn.com:8285/",
  in: "wss://mqe.tuyain.com:8285/",
};

// ── AES-128-ECB decryption (matches SDK's decryptByECB) ────────────────────

function decryptByECB(base64Data, accessSecret) {
  const key = accessSecret.substring(8, 24); // middle 16 chars
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const encrypted = Buffer.from(base64Data, "base64");
  return JSON.parse(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
  );
}

// ── AES-128-GCM decryption (matches SDK's decryptByGCM) ────────────────────

function decryptByGCM(base64Data, accessSecret) {
  const buf = Buffer.from(base64Data, "base64");
  const iv = buf.slice(0, 12);
  const tag = buf.slice(-16);
  const cdata = buf.slice(12, buf.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", accessSecret.substring(8, 24), iv);
  decipher.setAuthTag(tag);
  let dataStr = decipher.update(cdata, undefined, "utf8");
  dataStr += decipher.final("utf8");
  return JSON.parse(dataStr);
}

// ── Pulsar password (matches SDK's buildPassword) ──────────────────────────

function md5Hex(str) {
  return createHash("md5").update(str).digest("hex");
}

function buildPassword(accessId, accessSecret) {
  return md5Hex(accessId + md5Hex(accessSecret)).substring(8, 24);
}

// ── Main connection ────────────────────────────────────────────────────────

/**
 * Connect to Tuya Pulsar and invoke `onStatus(deviceId, statusArray)` for
 * every device status report.
 *
 * @param {object} opts
 * @param {string} opts.accessId
 * @param {string} opts.accessSecret
 * @param {string} opts.region - us | eu | cn | in
 * @param {(deviceId: string, status: Array<{code: string, value: any}>) => void} opts.onStatus
 * @returns {{ close: () => void }}
 */
export function connectPulsar({ accessId, accessSecret, region, onStatus }) {
  const baseUrl = REGION_ENDPOINTS[region];
  if (!baseUrl) throw new Error(`Invalid Pulsar region "${region}"`);

  const env = "event"; // production topic (SDK uses "event" for PROD)

  // SDK uses `${accessId}-sub` as subscription name
  const wsUrl =
    `${baseUrl}ws/v2/consumer/persistent/${accessId}/out/${env}/${accessId}-sub` +
    `?ackTimeoutMillis=30000&subscriptionType=Failover`;

  const password = buildPassword(accessId, accessSecret);

  let ws = null;
  let closed = false;
  let backoff = 1000;
  let heartbeatTimer = null;

  function connect() {
    if (closed) return;

    // Log URL (mask accessId for security)
    const safeUrl = wsUrl.replace(accessId, accessId.slice(0, 4) + "***");
    log.info(`Connecting to Pulsar (${region}): ${safeUrl}`);

    // Auth via headers (matches SDK: { headers: { username, password } })
    ws = new WebSocket(wsUrl, {
      rejectUnauthorized: false,
      headers: { username: accessId, password },
    });

    ws.on("open", () => {
      log.info("Connected to Tuya Pulsar");
      backoff = 1000;
      resetHeartbeat();
    });

    ws.on("message", (raw) => {
      resetHeartbeat();
      try {
        log.info(`Raw message received (${raw.toString().length} bytes)`);
        const msg = JSON.parse(raw.toString());
        handleMessage(msg);
      } catch (err) {
        log.error(`Failed to parse message: ${err.message}`);
      }
    });

    ws.on("ping", () => {
      resetHeartbeat();
      ws.pong(accessId);
    });

    ws.on("error", (err) => {
      log.error(`WebSocket error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      clearHeartbeat();
      if (closed) return;
      log.warn(`WebSocket closed (${code}), reconnecting in ${backoff / 1000}s…`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  }

  function resetHeartbeat() {
    clearHeartbeat();
    // Send ping after 30s of silence (matches SDK's timeout default)
    heartbeatTimer = setTimeout(() => {
      try { ws?.ping(accessId); } catch {}
    }, 30_000);
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function handleMessage(msg) {
    const { messageId, payload, properties } = msg;

    // ACK immediately to prevent redelivery
    if (messageId && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ messageId }));
    }

    if (!payload) return;

    try {
      // SDK flow: base64 → UTF-8 string → JSON, then decrypt the `data` field
      const pStr = Buffer.from(payload, "base64").toString("utf-8");
      const pJson = JSON.parse(pStr);

      const encryptyModel = properties?.em;
      const data = encryptyModel === "aes_gcm"
        ? decryptByGCM(pJson.data, accessSecret)
        : decryptByECB(pJson.data, accessSecret);

      const { devId, status, bizCode } = data || {};

      log.info(`Decoded: bizCode=${bizCode} devId=${devId?.slice(0, 8)}… status=${JSON.stringify(status)}`);

      // We only care about device status reports
      if (bizCode && bizCode !== "statusReport") {
        log.info(`Ignoring bizCode=${bizCode}`);
        return;
      }

      if (devId && Array.isArray(status)) {
        log.event(`Push: device ${devId.slice(0, 8)}… status=[${status.map(s => `${s.code}=${s.value}`).join(", ")}]`);
        onStatus(devId, status);
      }
    } catch (err) {
      log.error(`Failed to decrypt/process payload: ${err.message}`);
    }
  }

  connect();

  return {
    close() {
      closed = true;
      clearHeartbeat();
      ws?.close();
      log.info("Pulsar client closed");
    },
  };
}
