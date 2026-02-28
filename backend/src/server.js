import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import deviceRoutes from "./routes/device.js";
import scheduleRoutes from "./routes/schedule.js";
import { sseHandler, startBackgroundPoll } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
  }
  next();
});

// SSE endpoint (before API routes to avoid JSON body parsing)
app.get("/api/events", sseHandler);

// API routes
app.use("/api", deviceRoutes);
app.use("/api", scheduleRoutes);

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
