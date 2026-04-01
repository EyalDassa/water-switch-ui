/**
 * Tuya Cloud API client using Node.js built-ins only.
 * Implements HMAC-SHA256 request signing per Tuya's authentication spec.
 *
 * Supports two modes:
 * - Simple mode (global): ACCESS_ID + ACCESS_SECRET → automatic token via grant_type=1
 * - User mode (per-user): ACCESS_ID + ACCESS_SECRET + user's token/refreshToken from QR login
 *
 * Node.js 18+ is required for the built-in `fetch` and `crypto` modules.
 */

import { createHmac, createHash } from "crypto";
import "dotenv/config";
import { createLogger, logPoll } from "./logger.js";

const log = createLogger("tuya");

// Paths that fire every poll cycle — only log when LOG_POLL=true
const POLL_PATHS = ["/v1.0/iot-03/devices/", "/v1.0/devices/"];
function isPollPath(path) {
  return POLL_PATHS.some((p) => path.startsWith(p)) && !path.includes("/logs") && !path.includes("/commands");
}

const REGION_ENDPOINTS = {
  us: "https://openapi.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};

export class TuyaClient {
  #accessId;
  #accessSecret;
  #baseUrl;
  #region;
  #cachedToken = null;
  #tokenExpiry = 0;
  #refreshToken = null;
  #onTokenRefresh = null;
  #tokenPromise = null;

  /**
   * @param {object} opts
   * @param {string} opts.accessId - Tuya project client ID
   * @param {string} opts.accessSecret - Tuya project client secret
   * @param {string} opts.region - Region code (us, eu, cn, in)
   * @param {string} [opts.baseUrl] - Override base URL (e.g. for QR API at apigw.iotbing.com)
   * @param {string} [opts.token] - Pre-obtained access token (user mode)
   * @param {string} [opts.refreshToken] - Refresh token (user mode)
   * @param {function} [opts.onTokenRefresh] - Called with (newToken, newRefreshToken) on refresh
   */
  constructor({ accessId, accessSecret, region, baseUrl, token, refreshToken, onTokenRefresh }) {
    this.#accessId = accessId;
    this.#accessSecret = accessSecret;
    this.#region = region;
    this.#baseUrl = baseUrl || REGION_ENDPOINTS[region];
    if (!this.#baseUrl) throw new Error(`Invalid region "${region}". Use: us, eu, cn, in`);
    if (token) {
      this.#cachedToken = token;
      this.#tokenExpiry = Date.now() + 7000 * 1000; // ~2hr assumed
    }
    this.#refreshToken = refreshToken || null;
    this.#onTokenRefresh = onTokenRefresh || null;
  }

  get region() { return this.#region; }
  get isSharing() { return false; }

  async #getToken() {
    if (this.#cachedToken && Date.now() < this.#tokenExpiry) return this.#cachedToken;

    // Deduplicate concurrent token requests
    if (this.#tokenPromise) return this.#tokenPromise;

    this.#tokenPromise = this.#fetchToken();
    try {
      return await this.#tokenPromise;
    } finally {
      this.#tokenPromise = null;
    }
  }

  async #fetchToken() {
    if (this.#refreshToken) {
      // User mode: refresh using refresh_token
      log.info("Refreshing user token...");
      const result = await this.#signedRequest("GET", `/v1.0/token/${this.#refreshToken}`, null, true);
      this.#cachedToken = result.access_token;
      this.#refreshToken = result.refresh_token;
      const buffer = result.expire_time > 120 ? 60 : 0;
      this.#tokenExpiry = Date.now() + (result.expire_time - buffer) * 1000;
      this.#onTokenRefresh?.(result.access_token, result.refresh_token);
      log.info(`User token refreshed, expires in ${result.expire_time}s`);
      return this.#cachedToken;
    }

    // Simple mode: fetch new project token
    log.info("Fetching new access token...");
    const result = await this.#signedRequest("GET", "/v1.0/token?grant_type=1", null, true);
    this.#cachedToken = result.access_token;
    const buffer = result.expire_time > 120 ? 60 : 0;
    this.#tokenExpiry = Date.now() + (result.expire_time - buffer) * 1000;
    log.info(`Token obtained, expires in ${result.expire_time}s`);
    return this.#cachedToken;
  }

  #sign(str, secret) {
    return createHmac("sha256", secret).update(str).digest("hex").toUpperCase();
  }

  async #signedRequest(method, path, body = null, isTokenRequest = false, _retry = 0) {
    const timestamp = String(Date.now());
    const nonce = Math.random().toString(36).slice(2);
    const token = isTokenRequest ? "" : await this.#getToken();

    const bodyHash = body
      ? createHash("sha256").update(JSON.stringify(body)).digest("hex")
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    let signUrl = path;
    const qIdx = path.indexOf("?");
    if (qIdx !== -1) {
      const basePath = path.slice(0, qIdx);
      const qs = path.slice(qIdx + 1);
      const sorted = qs.split("&").sort().join("&");
      signUrl = basePath + "?" + sorted;
    }

    const stringToSign = [method, bodyHash, "", signUrl].join("\n");
    const signStr = this.#accessId + token + timestamp + nonce + stringToSign;
    const signature = this.#sign(signStr, this.#accessSecret);

    const headers = {
      client_id: this.#accessId,
      access_token: token,
      sign: signature,
      t: timestamp,
      nonce,
      sign_method: "HMAC-SHA256",
      "Content-Type": "application/json",
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const url = `${this.#baseUrl}${path}`;
    const isPoll = isPollPath(path);
    if (!isPoll || logPoll) log.debug(`${method} ${path}`);

    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      const detail = err.cause ? JSON.stringify(err.cause) : err.message;
      log.error(`FETCH ERROR ${method} ${path}: ${detail}`);
      throw new Error(`Tuya fetch failed for ${url}: ${detail}`);
    }
    const data = await res.json();

    if (!data.success && data.code === 501 && _retry < 1) {
      log.warn(`501 transient error on ${path}, retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
      return this.#signedRequest(method, path, body, isTokenRequest, _retry + 1);
    }

    if (!data.success) {
      log.error(`API ERROR ${method} ${path}: [${data.code}] ${data.msg}`);
      throw new Error(`Tuya API error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
    }

    if (!isPoll || logPoll) log.debug(`${method} ${path} OK`);
    return data.result;
  }

  get(path) { return this.#signedRequest("GET", path); }
  post(path, body) { return this.#signedRequest("POST", path, body); }
  put(path, body) { return this.#signedRequest("PUT", path, body); }
  delete(path) { return this.#signedRequest("DELETE", path); }
}

// ── Default global client from .env ──────────────────────────────────────────

const ACCESS_ID = process.env.ACCESS_ID;
const ACCESS_SECRET = process.env.ACCESS_SECRET;
const REGION = process.env.TUYA_REGION || "eu";

export const DEFAULT_DEVICE_ID = process.env.DEVICE_ID || null;
export const DEFAULT_HOME_ID = process.env.HOME_ID || null;

if (!ACCESS_ID || !ACCESS_SECRET) throw new Error("Missing ACCESS_ID or ACCESS_SECRET in .env");
if (!DEFAULT_DEVICE_ID) log.warn("No default DEVICE_ID in .env (per-user binding mode)");
if (!DEFAULT_HOME_ID) log.warn("No default HOME_ID in .env (per-user binding mode)");

export const defaultClient = new TuyaClient({ accessId: ACCESS_ID, accessSecret: ACCESS_SECRET, region: REGION });

log.info(`region=${REGION} base=${REGION_ENDPOINTS[REGION]} device=${DEFAULT_DEVICE_ID || "none"} home=${DEFAULT_HOME_ID || "none"}`);
log.info(`ACCESS_ID=${ACCESS_ID.slice(0, 4)}***`);

// Re-export for backward compat during migration
export const tuya = defaultClient;
export const DEVICE_ID = DEFAULT_DEVICE_ID;
export const HOME_ID = DEFAULT_HOME_ID;
