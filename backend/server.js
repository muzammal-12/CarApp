// backend/server.js
// ✅ Load .env BEFORE anything that reads env vars
import "dotenv/config";

import express from "express";
import mongoose from "mongoose";
import cors from "cors";

// Your ESM routes/middleware
import authRoutes from "./routes/auth.js";
import vehiclesRoutes from "./routes/vehicles.js";
import usersRoutes from "./routes/users.js";
import requireAuth from "./middleware/requireAuth.js";

// Cloudinary diagnostics (safe booleans only)
import { cloudinaryConfigured, CLOUDINARY_FOLDER } from "./utils/cloudinary.js";

// ESM routes for uploads & inspections
import uploadsRouter from "./routes/uploads.js";
import inspectionsRouter from "./routes/inspections.js";

// Guides & Learnings chat routes (sessions + messages, Gemini-backed)
import guidesChatRoutes from "./routes/guidesChat.js";

// Pricing: Gemini-only assessment (no predefined baselines)
import pricingCatalogRoutes from "./routes/pricingCatalog.js";

const app = express();

/* ─────────── Trust proxy ─────────── */
app.set("trust proxy", 1);

/* ─────────── Boot diagnostics ─────────── */
console.log(`[cloudinary] configured=${cloudinaryConfigured} folder=${CLOUDINARY_FOLDER}`);

/* ─────────── Tiny request logger ─────────── */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`);
  });
  next();
});

/* ─────────── CORS ─────────── */
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : true; // reflect origin in dev
const corsOptions = { origin: corsOrigins, credentials: false }; // Bearer JWT only
app.use(cors(corsOptions));
// Express 5: use a pattern for preflight
app.options(/.*/, cors(corsOptions));

/* ─────────── Parsers ─────────── */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────── Health & diagnostics ─────────── */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/diagnostics/ping", requireAuth, async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ ok: true, userId: req.userId, mongo: "ok" });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e?.message || String(e) });
  }
});

app.get("/api/diagnostics/cloudinary", (_req, res) => {
  res.json({
    configured: cloudinaryConfigured,
    cloud: !!process.env.CLOUDINARY_CLOUD_NAME,
    key: !!process.env.CLOUDINARY_API_KEY,
    secret: !!process.env.CLOUDINARY_API_SECRET,
    urlVar: !!process.env.CLOUDINARY_URL,
    folder: CLOUDINARY_FOLDER,
  });
});

/* ─────────── Routes ─────────── */
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/vehicles", vehiclesRoutes);

// Uploads & Gemini inspections
app.use("/api/uploads", uploadsRouter);
app.use("/api/inspections", inspectionsRouter);

// Pricing (Gemini-only assessment endpoints)
app.use("/api/pricing", pricingCatalogRoutes);

// Guides & Learnings Chat (sessions, messages, Gemini)
app.use("/api/guides/chat", guidesChatRoutes);

/* ─────────── Error handler ─────────── */
app.use((err, _req, res, _next) => {
  console.error("🔥 Unhandled route error:", err?.stack || err);
  const status = err?.status || 500;
  const msg = err?.msg || err?.message || "Server error";
  res.status(status).json({ msg });
});

/* ─────────── DB + Server ─────────── */
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully!");
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

/* ─────────── Graceful shutdown ─────────── */
process.on("SIGINT", async () => {
  console.log("Shutting down…");
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(0);
});
