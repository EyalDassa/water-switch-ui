import { getAuth } from "@clerk/express";
import { createClerkClient } from "@clerk/express";
import { defaultClient, DEFAULT_DEVICE_ID, DEFAULT_HOME_ID } from "../tuya.js";
import { SharingClient, SHARING_CLIENT_ID } from "../sharing.js";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// In-memory cache of per-user client instances (SharingClient or default TuyaClient)
const userClients = new Map();

/**
 * Middleware: extract user's device config and create a per-user client.
 * Sets req.deviceConfig = { deviceId, homeId } and req.tuya = client instance.
 * For QR-linked users, req.tuya is a SharingClient (req.tuya.isSharing === true).
 */
export async function extractDeviceConfig(req, res, next) {
  const { userId, sessionClaims } = getAuth(req);
  const pub = sessionClaims?.publicMetadata;

  const deviceId = pub?.deviceId || DEFAULT_DEVICE_ID;
  const homeId = pub?.homeId || DEFAULT_HOME_ID;

  if (!deviceId || !homeId) {
    req.deviceConfig = null;
    req.tuya = null;
    return next();
  }

  req.deviceConfig = { deviceId, homeId, userId };

  // Check cache first
  if (userClients.has(userId)) {
    req.tuya = userClients.get(userId);
    return next();
  }

  // If using default device, use the default client (no Clerk API call needed)
  if (deviceId === DEFAULT_DEVICE_ID) {
    req.tuya = defaultClient;
    return next();
  }

  // Fetch user's Tuya tokens from Clerk privateMetadata → create SharingClient
  try {
    const user = await clerk.users.getUser(userId);
    const priv = user.privateMetadata;

    if (priv?.tuyaAccessToken) {
      const endpoint = priv.tuyaEndpoint || `https://apigw.tuya${priv.tuyaRegion || "eu"}.com`;
      const client = new SharingClient({
        clientId: SHARING_CLIENT_ID,
        accessToken: priv.tuyaAccessToken,
        refreshToken: priv.tuyaRefreshToken,
        endpoint,
        onTokenRefresh: async (newToken, newRefresh) => {
          await clerk.users.updateUserMetadata(userId, {
            privateMetadata: { ...priv, tuyaAccessToken: newToken, tuyaRefreshToken: newRefresh },
          });
        },
      });
      userClients.set(userId, client);
      req.tuya = client;
    } else {
      req.tuya = defaultClient;
    }
  } catch (err) {
    console.error(`[deviceConfig] Failed to load Tuya tokens for ${userId}:`, err.message);
    req.tuya = defaultClient;
  }

  next();
}

/**
 * Middleware: require a configured device. Returns 412 if none.
 */
export function requireDevice(req, res, next) {
  if (!req.deviceConfig) {
    return res.status(412).json({
      error: "no_device",
      message: "No device configured. Please set up your device first.",
    });
  }
  next();
}
