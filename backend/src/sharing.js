/**
 * Tuya Device Sharing API client.
 *
 * Implements the encrypted protocol used by tuya-device-sharing-sdk:
 * - Per-request signing key derived from MD5(uuid + refreshToken)
 * - AES-128-GCM encryption of query params and request body
 * - AES-128-GCM decryption of response body
 * - Different headers: X-appKey, X-requestId, X-sign, X-time, X-token
 * - Different API paths: /v1.0/m/life/... instead of /v1.0/...
 *
 * Used for users who connect via QR code (device-sharing flow).
 */

import { createHash, createHmac, createCipheriv, createDecipheriv, randomUUID, randomBytes } from "crypto";

function randomNonce(size) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const bytes = randomBytes(size);
  for (let i = 0; i < size; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function aesGcmEncrypt(plaintext, secret) {
  const nonce = Buffer.from(randomNonce(12), "utf-8");
  const key = Buffer.from(secret, "utf-8");
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Match Python SDK: base64(nonce) + base64(encrypted + tag)
  return nonce.toString("base64") + Buffer.concat([encrypted, tag]).toString("base64");
}

function aesGcmDecrypt(cipherData, secret) {
  // Response format: base64(nonce + ciphertext + tag)
  const raw = Buffer.from(cipherData, "base64");
  const nonce = raw.subarray(0, 12);
  const ciphertextWithTag = raw.subarray(12);
  const tag = ciphertextWithTag.subarray(-16);
  const ciphertext = ciphertextWithTag.subarray(0, -16);
  const key = Buffer.from(secret, "utf-8");
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// The device-sharing SDK always uses the Home Assistant app key, NOT the project ACCESS_ID
export const SHARING_CLIENT_ID = "HA_3y9q4ak7g4ephrvke";

export class SharingClient {
  #clientId;
  #accessToken;
  #refreshToken;
  #endpoint;
  #onTokenRefresh;

  /**
   * @param {object} opts
   * @param {string} opts.clientId - Tuya project ACCESS_ID
   * @param {string} opts.accessToken - User's access token from QR login
   * @param {string} opts.refreshToken - User's refresh token
   * @param {string} opts.endpoint - Regional API endpoint (e.g. https://apigw.tuyaeu.com)
   * @param {function} [opts.onTokenRefresh] - Called with (newAccessToken, newRefreshToken) on refresh
   */
  constructor({ clientId, accessToken, refreshToken, endpoint, onTokenRefresh }) {
    this.#clientId = clientId;
    this.#accessToken = accessToken;
    this.#refreshToken = refreshToken;
    this.#endpoint = endpoint;
    this.#onTokenRefresh = onTokenRefresh || null;
  }

  /** Marker so routes can detect sharing vs standard client */
  get isSharing() { return true; }

  #deriveKeys(rid) {
    const hashKey = createHash("md5").update(rid + this.#refreshToken).digest("hex");
    const secret = createHmac("sha256", rid).update(hashKey).digest("hex").slice(0, 16);
    return { hashKey, secret };
  }

  #computeSign(hashKey, headers, queryEncdata, bodyEncdata) {
    const signHeaders = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"];
    let signStr = "";
    for (const h of signHeaders) {
      const val = headers[h] || "";
      if (val !== "") {
        signStr += `${h}=${val}||`;
      }
    }
    signStr = signStr.slice(0, -2); // strip trailing "||"
    if (queryEncdata) signStr += queryEncdata;
    if (bodyEncdata) signStr += bodyEncdata;
    return createHmac("sha256", hashKey).update(signStr).digest("hex");
  }

  async #request(method, path, query = null, body = null, _retry = 0) {
    const rid = randomUUID();
    const { hashKey, secret } = this.#deriveKeys(rid);
    const t = String(Date.now());

    const headers = {
      "X-appKey": this.#clientId,
      "X-requestId": rid,
      "X-sid": "",
      "X-time": t,
      "Content-Type": "application/json",
    };
    if (this.#accessToken) {
      headers["X-token"] = this.#accessToken;
    }

    // Encrypt query params
    let queryEncdata = "";
    let url = `${this.#endpoint}${path}`;
    if (query && Object.keys(query).length > 0) {
      queryEncdata = aesGcmEncrypt(JSON.stringify(query), secret);
      url += `?encdata=${encodeURIComponent(queryEncdata)}`;
    }

    // Encrypt body
    let bodyEncdata = "";
    const fetchOptions = { method, headers };
    if (body) {
      bodyEncdata = aesGcmEncrypt(JSON.stringify(body), secret);
      fetchOptions.body = JSON.stringify({ encdata: bodyEncdata });
    }

    // Sign
    headers["X-sign"] = this.#computeSign(hashKey, headers, queryEncdata, bodyEncdata);

    console.log(`[sharing] ${method} ${path}`);
    let res;
    try {
      res = await fetch(url, fetchOptions);
    } catch (err) {
      console.error(`[sharing] FETCH ERROR ${method} ${path}: ${err.message}`);
      throw new Error(`Sharing API fetch failed: ${err.message}`);
    }

    const data = await res.json();

    if (!data.success) {
      // Token expired — try refresh once
      if (data.code === 1010 && _retry < 1) {
        console.warn("[sharing] Token expired, refreshing...");
        await this.#refreshAccessToken();
        return this.#request(method, path, query, body, _retry + 1);
      }
      console.error(`[sharing] API ERROR ${method} ${path}: [${data.code}] ${data.msg}`);
      throw new Error(`Sharing API error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
    }

    // Decrypt result if encrypted (string = encrypted, object = plain)
    let result = data.result;
    if (typeof result === "string" && result.length > 0) {
      try {
        const decrypted = aesGcmDecrypt(result, secret);
        result = JSON.parse(decrypted);
      } catch {
        // Leave as-is if decryption fails
      }
    }

    console.log(`[sharing] ${method} ${path} OK`);
    return result;
  }

  async #refreshAccessToken() {
    const result = await this.#request("GET", `/v1.0/m/token/${this.#refreshToken}`);
    this.#accessToken = result.access_token;
    this.#refreshToken = result.refresh_token;
    this.#onTokenRefresh?.(result.access_token, result.refresh_token);
    console.log("[sharing] Token refreshed");
  }

  // ── Public API matching the paths used by tuya-device-sharing-sdk ──────────

  /** List user's homes */
  async getHomes() {
    return this.#request("GET", "/v1.0/m/life/users/homes");
  }

  /** List devices in a home */
  async getHomeDevices(homeId) {
    return this.#request("GET", "/v1.0/m/life/ha/home/devices", { homeId: String(homeId) });
  }

  /** Get device status (DPs) */
  async getDeviceStatus(deviceId) {
    return this.#request("GET", `/v1.0/m/life/devices/${deviceId}/status`);
  }

  /** Send commands to a device */
  async sendCommands(deviceId, commands) {
    return this.#request("POST", `/v1.1/m/thing/${deviceId}/commands`, null, { commands });
  }

  /** Get device logs */
  async getDeviceLogs(deviceId, params) {
    return this.#request("GET", `/v1.0/m/life/devices/${deviceId}/logs`, params);
  }

  /** List scenes/automations for a home */
  async getScenes(homeId) {
    return this.#request("GET", "/v1.0/m/scene/ha/home/scenes", { homeId: String(homeId) });
  }

  /** Trigger a scene */
  async triggerScene(homeId, sceneId) {
    return this.#request("POST", "/v1.0/m/scene/ha/trigger", null, { homeId: String(homeId), sceneId });
  }
}
