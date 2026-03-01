import { Router } from "express";
import { getAuth } from "@clerk/express";
import { createClerkClient } from "@clerk/express";
import { defaultClient } from "../tuya.js";
import { SharingClient, SHARING_CLIENT_ID } from "../sharing.js";

const router = Router();

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// QR login uses Tuya's device-sharing API — unauthenticated, fixed client ID + schema
const QR_BASE = "https://apigw.iotbing.com";
const QR_CLIENT_ID = "HA_3y9q4ak7g4ephrvke";
const QR_SCHEMA = "haauthorize";

async function qrFetch(url) {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  console.log("[setup] QR API response:", JSON.stringify(data));
  return data;
}

// ── POST /api/setup/qr-code ─────────────────────────────────────────────────
// Generate a QR code for SmartLife app scanning
router.post("/setup/qr-code", async (req, res) => {
  const { userCode } = req.body;
  if (!userCode) {
    return res.status(400).json({ error: "userCode is required" });
  }

  try {
    const url = `${QR_BASE}/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${QR_CLIENT_ID}&usercode=${userCode}&schema=${QR_SCHEMA}`;
    const data = await qrFetch(url);

    if (!data.success) {
      return res.status(502).json({ error: data.msg || "Failed to generate QR code" });
    }

    // The qrcode value is both the polling token and the QR content
    const qrcode = data.result.qrcode;
    const qrContent = `tuyaSmart--qrLogin?token=${qrcode}`;
    console.log("[setup] QR content:", qrContent);

    res.json({
      token: qrcode,
      qrCodeUrl: qrContent,
    });
  } catch (err) {
    console.error("[setup] QR code error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/setup/qr-poll ─────────────────────────────────────────────────
// Poll for QR code scan completion
router.post("/setup/qr-poll", async (req, res) => {
  const { token, userCode } = req.body;
  if (!token || !userCode) {
    return res.status(400).json({ error: "token and userCode are required" });
  }

  try {
    // SDK uses GET to poll: /v1.0/m/life/home-assistant/qrcode/tokens/{token}
    const url = `${QR_BASE}/v1.0/m/life/home-assistant/qrcode/tokens/${token}?clientid=${QR_CLIENT_ID}&usercode=${userCode}`;
    const pollRes = await fetch(url, { method: "GET" });
    const data = await pollRes.json();

    if (!data.success) {
      // Not scanned yet
      return res.json({ status: "pending" });
    }

    const result = data.result;
    const { userId } = getAuth(req);

    // The login result may include an endpoint (regional API base) for this user
    const userEndpoint = result.endpoint || null;
    console.log("[setup] QR login success, uid:", result.uid, "endpoint:", userEndpoint);

    // Save Tuya tokens to Clerk privateMetadata
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: {
        tuyaAccessToken: result.access_token,
        tuyaRefreshToken: result.refresh_token,
        tuyaUid: result.uid,
        tuyaRegion: defaultClient.region,
        tuyaEndpoint: userEndpoint,
      },
    });

    // Discover user's devices via the sharing API
    const sharingClient = new SharingClient({
      clientId: SHARING_CLIENT_ID,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      endpoint: userEndpoint || `https://apigw.tuya${defaultClient.region}.com`,
    });

    const devices = await discoverDevices(sharingClient);

    res.json({ status: "success", devices });
  } catch (err) {
    console.error("[setup] QR poll error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/setup/devices ──────────────────────────────────────────────────
// List user's devices (requires Tuya tokens in privateMetadata)
router.get("/setup/devices", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const user = await clerk.users.getUser(userId);
    const meta = user.privateMetadata;

    if (!meta?.tuyaAccessToken) {
      return res.status(412).json({ error: "no_tuya_auth", message: "Complete QR login first" });
    }

    const sharingClient = new SharingClient({
      clientId: SHARING_CLIENT_ID,
      accessToken: meta.tuyaAccessToken,
      refreshToken: meta.tuyaRefreshToken,
      endpoint: meta.tuyaEndpoint || `https://apigw.tuya${meta.tuyaRegion || "eu"}.com`,
      onTokenRefresh: async (newToken, newRefresh) => {
        await clerk.users.updateUserMetadata(userId, {
          privateMetadata: { ...meta, tuyaAccessToken: newToken, tuyaRefreshToken: newRefresh },
        });
      },
    });

    const devices = await discoverDevices(sharingClient);
    res.json({ devices });
  } catch (err) {
    console.error("[setup] List devices error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/setup/select-device ───────────────────────────────────────────
// Save selected device to Clerk publicMetadata
router.post("/setup/select-device", async (req, res) => {
  const { deviceId, homeId, deviceName } = req.body;
  if (!deviceId || !homeId) {
    return res.status(400).json({ error: "deviceId and homeId are required" });
  }

  const { userId } = getAuth(req);

  try {
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { deviceId, homeId, deviceName: deviceName || null, configured: true },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[setup] Select device error:", err.message);
    res.status(500).json({ error: "Failed to save device configuration" });
  }
});

// ── GET /api/setup/status ───────────────────────────────────────────────────
// Check if user has a device configured
router.get("/setup/status", async (req, res) => {
  const { sessionClaims } = getAuth(req);
  const meta = sessionClaims?.publicMetadata;

  res.json({
    configured: !!(meta?.deviceId && meta?.homeId),
    deviceId: meta?.deviceId || null,
    homeId: meta?.homeId || null,
    deviceName: meta?.deviceName || null,
  });
});

// ── Helper: discover devices across user's homes via sharing API ─────────
async function discoverDevices(sharingClient) {
  const devices = [];

  try {
    const homes = await sharingClient.getHomes();
    console.log("[setup] Found homes:", JSON.stringify(homes));

    for (const home of homes || []) {
      const homeId = home.homeId || home.home_id || home.ownerId;
      const homeName = home.name || "Home";
      try {
        const homeDevices = await sharingClient.getHomeDevices(homeId);
        for (const d of homeDevices || []) {
          devices.push({
            deviceId: d.id || d.devId,
            name: d.name || d.custom_name || "Unknown Device",
            category: d.category,
            isOnline: d.online ?? d.isOnline ?? false,
            homeId: String(homeId),
            homeName,
          });
        }
      } catch (err) {
        console.warn(`[setup] Failed to list devices for home ${homeId}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[setup] Failed to discover devices:", err.message);
  }

  return devices;
}

export default router;
