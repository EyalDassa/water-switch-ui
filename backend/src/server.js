import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { extractDeviceConfig, requireDevice } from "./middleware/deviceConfig.js";
import setupRoutes from "./routes/setup.js";
import deviceRoutes from "./routes/device.js";
import scheduleRoutes from "./routes/schedule.js";
import { sseHandler, startBackgroundPoll } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy (behind nginx + Cloudflare)
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// Clerk: populate req.auth on every request
app.use(clerkMiddleware());

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    const start = Date.now();
    res.on("finish", () => {
      const auth = getAuth(req);
      const uid = auth?.userId ? auth.userId.slice(0, 8) + "..." : "anon";
      console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms [${uid}]`);
    });
  }
  next();
});

// API auth guard: returns 401 for unauthenticated requests
function requireApiAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Setup routes — no device required (this IS the device setup)
app.use("/api", requireApiAuth, setupRoutes);

// SSE endpoint — requires configured device
app.get("/api/events", requireApiAuth, extractDeviceConfig, sseHandler);

// API routes — require configured device
app.use("/api", requireApiAuth, extractDeviceConfig, requireDevice, deviceRoutes);
app.use("/api", requireApiAuth, extractDeviceConfig, requireDevice, scheduleRoutes);

// Serve the built React frontend in production
const frontendDist = join(__dirname, "../../frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (req, res) => {
  res.sendFile(join(frontendDist, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Water Switch UI backend running on http://0.0.0.0:${PORT}`);
  console.log(`API available at http://0.0.0.0:${PORT}/api`);
  startBackgroundPoll();
});
