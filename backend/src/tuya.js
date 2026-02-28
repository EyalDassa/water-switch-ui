/**
 * Lightweight Tuya Cloud API client using Node.js built-ins only.
 * Implements HMAC-SHA256 request signing per Tuya's authentication spec:
 * https://developer.tuya.com/en/docs/iot/authentication-method
 *
 * Node.js 18+ is required for the built-in `fetch` and `crypto` modules.
 */

import { createHmac, createHash } from "crypto";
import "dotenv/config";

const REGION_ENDPOINTS = {
  us: "https://openapi.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};

const ACCESS_ID = process.env.ACCESS_ID;
const ACCESS_SECRET = process.env.ACCESS_SECRET;
const REGION = process.env.TUYA_REGION || "eu";

export const DEVICE_ID = process.env.DEVICE_ID;
export const HOME_ID = process.env.HOME_ID;

const BASE_URL = REGION_ENDPOINTS[REGION];

if (!BASE_URL) throw new Error(`Invalid TUYA_REGION "${REGION}". Use: us, eu, cn, in`);
if (!ACCESS_ID || !ACCESS_SECRET) throw new Error("Missing ACCESS_ID or ACCESS_SECRET in .env");
if (!DEVICE_ID) throw new Error("Missing DEVICE_ID in .env");
if (!HOME_ID) throw new Error("Missing HOME_ID in .env");

// ── Token cache ────────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const result = await signedRequest("GET", "/v1.0/token?grant_type=1", null, true);
  cachedToken = result.access_token;
  // Tokens expire in 7200s; refresh 60s early
  tokenExpiry = Date.now() + (result.expire_time - 60) * 1000;
  return cachedToken;
}

// ── HMAC-SHA256 signing ────────────────────────────────────────────────────────
function sign(str, secret) {
  return createHmac("sha256", secret).update(str).digest("hex").toUpperCase();
}

async function signedRequest(method, path, body = null, isTokenRequest = false, _retry = 0) {
  const timestamp = String(Date.now());
  const nonce = Math.random().toString(36).slice(2);

  const token = isTokenRequest ? "" : await getToken();

  // Build string-to-sign per Tuya docs
  const bodyHash = body
    ? createHash("sha256").update(JSON.stringify(body)).digest("hex")
    : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA256("")

  // Separate path and query params — Tuya signing requires sorted query string
  let signUrl = path;
  const qIdx = path.indexOf("?");
  if (qIdx !== -1) {
    const basePath = path.slice(0, qIdx);
    const qs = path.slice(qIdx + 1);
    const sorted = qs.split("&").sort().join("&");
    signUrl = basePath + "?" + sorted;
  }

  const stringToSign = [
    method,
    bodyHash,
    "",          // content-MD5 (unused)
    signUrl,
  ].join("\n");

  const signStr = ACCESS_ID + token + timestamp + nonce + stringToSign;
  const signature = sign(signStr, ACCESS_SECRET);

  const headers = {
    "client_id": ACCESS_ID,
    "access_token": token,
    "sign": signature,
    "t": timestamp,
    "nonce": nonce,
    "sign_method": "HMAC-SHA256",
    "Content-Type": "application/json",
  };

  const options = {
    method,
    headers,
  };

  if (body) options.body = JSON.stringify(body);

  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new Error(`Tuya fetch failed for ${url}: ${err.cause ? JSON.stringify(err.cause) : err.message}`);
  }
  const data = await res.json();

  // Retry once on transient 501 errors
  if (!data.success && data.code === 501 && _retry < 1) {
    await new Promise((r) => setTimeout(r, 1000));
    return signedRequest(method, path, body, isTokenRequest, _retry + 1);
  }

  if (!data.success) {
    throw new Error(`Tuya API error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
  }

  return data.result;
}

// ── Public API ─────────────────────────────────────────────────────────────────
export const tuya = {
  get: (path) => signedRequest("GET", path),
  post: (path, body) => signedRequest("POST", path, body),
  put: (path, body) => signedRequest("PUT", path, body),
  delete: (path) => signedRequest("DELETE", path),
};
