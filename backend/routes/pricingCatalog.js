// backend/routes/pricingCatalog.js
import express from "express";
import mongoose from "mongoose";
import requireAuth from "../middleware/requireAuth.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router = express.Router();

/* ──────────────────────────────────────────────────────────────────────────
 * Constants
 * ────────────────────────────────────────────────────────────────────────── */
const DEFAULT_CURRENCY = "USD";
const GEMINI_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */
function normalizeServiceKey(raw = "") {
  const s = String(raw || "").toLowerCase();
  if (!s) return "";
  if (s.includes("oil")) return "oil_change";
  if (s.includes("brake") && s.includes("rotor")) return "rotors";
  if (s.includes("brake")) return "brake_pads";
  if (s.includes("air filter") || s.includes("engine filter")) return "air_filter";
  if (s.includes("cabin") || s.includes("pollen")) return "cabin_filter";
  if (s.includes("coolant") || s.includes("radiator")) return "coolant";
  if (s.includes("tire") || s.includes("tyre")) return "tires";
  if (s.includes("spark")) return "spark_plugs";
  if (s.includes("transmission")) return "transmission_fluid";
  if (s.includes("battery")) return "battery";
  if (s.includes("wiper")) return "wiper_blades";
  return s.replace(/[^a-z0-9_]+/g, "_");
}

function tryExtractJsonBlock(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Gemini (1.5-flash)
 * ────────────────────────────────────────────────────────────────────────── */

function buildGeminiPromptSingle({
  vehicle_make,
  vehicle_model,
  vehicle_year,
  service_name,
  quoted_amount,
  // currency forced to USD; do not accept overrides
  location_city,
  location_country,
  extra_notes,
}) {
  return [
    "You are an automotive service price assessor.",
    "Decide if a user-provided quote is FAIR or OVERPRICED for the given vehicle and service.",
    "Use broad market knowledge and reasonable heuristics. If not confident, return 'unknown'.",
    "Respond with JSON ONLY:",
    `{
  "decision": "fair" | "overpriced" | "unknown",
  "confidence": 0.0-1.0,
  "rationale": "short reason",
  "inferred_fair_range": {"min": number?, "max": number?, "currency": "USD"?},
  "model_notes": "optional"
}`,
    "",
    `Vehicle: ${vehicle_year} ${vehicle_make} ${vehicle_model}`,
    `Service: ${service_name}`,
    `Quoted Price: ${quoted_amount} ${DEFAULT_CURRENCY}`,
    location_city || location_country
      ? `Location: ${[location_city, location_country].filter(Boolean).join(", ")}`
      : "Location: (not provided; assume major city baseline)",
    extra_notes ? `Notes: ${extra_notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

let genAI = null;
if (GEMINI_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_KEY);
  } catch (e) {
    console.error("[pricing] Gemini init error:", e?.message || e);
  }
}

async function assessWithGeminiFlash(payload) {
  if (!genAI) {
    const err = new Error("Gemini API key not configured");
    err.status = 503;
    throw err;
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction:
      "You are an automotive price assessor. Output JSON only. If unsure, use decision 'unknown'. Keep rationale concise.",
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });

  const prompt = buildGeminiPromptSingle(payload);

  // Correct call shape for this SDK
  const resp = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const raw = resp?.response?.text() ?? "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = tryExtractJsonBlock(raw);
  }
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("AI output invalid");
    err.status = 502;
    err.raw = raw;
    throw err;
  }

  const decision = typeof parsed.decision === "string" ? parsed.decision.toLowerCase() : "unknown";
  const confidence =
    typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";

  // Force currency to USD on output regardless of model text
  const inferred =
    parsed.inferred_fair_range && typeof parsed.inferred_fair_range === "object"
      ? {
          min:
            typeof parsed.inferred_fair_range.min === "number"
              ? parsed.inferred_fair_range.min
              : undefined,
          max:
            typeof parsed.inferred_fair_range.max === "number"
              ? parsed.inferred_fair_range.max
              : undefined,
          currency: DEFAULT_CURRENCY,
        }
      : undefined;

  return {
    decision: ["fair", "overpriced", "unknown"].includes(decision) ? decision : "unknown",
    confidence,
    rationale,
    inferred_fair_range: inferred,
    model_notes: typeof parsed.model_notes === "string" ? parsed.model_notes : undefined,
    model_id: GEMINI_MODEL,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Models (crowd samples only; NO predefined catalogs)
 * ────────────────────────────────────────────────────────────────────────── */

const ServicePriceSampleSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    vehicleId: { type: String, index: true },
    serviceKey: { type: String, index: true },
    label: { type: String },
    qty: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    vendor: { type: String, default: null },
    city: { type: String, default: null, index: true },
    region: { type: String, default: "GLOBAL", index: true },
    currency: { type: String, default: DEFAULT_CURRENCY },
    raw: { type: Object, default: null }, // includes { vehicle, ai, notes }
  },
  { timestamps: true }
);
const ServicePriceSample =
  mongoose.models.ServicePriceSample ||
  mongoose.model("ServicePriceSample", ServicePriceSampleSchema);

/* ──────────────────────────────────────────────────────────────────────────
 * Routes (pure AI flow; USD only)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * POST /pricing/assess-quote
 * Body requires: vehicle_make, vehicle_model, vehicle_year, service_name, quoted_amount
 * Currency is always treated as USD.
 */
router.post("/assess-quote", requireAuth, async (req, res) => {
  try {
    const {
      vehicle_make,
      vehicle_model,
      vehicle_year,
      service_name,
      quoted_amount,
      // ignore incoming currency; always USD
      location_city = null,
      location_country = null,
      extra_notes = null,
      persist_assessment = false,
      vehicleId = null,
    } = req.body || {};

    if (
      !vehicle_make ||
      !vehicle_model ||
      typeof vehicle_year !== "number" ||
      !service_name ||
      typeof quoted_amount !== "number"
    ) {
      return res.status(400).json({
        error:
          "vehicle_make, vehicle_model, vehicle_year, service_name, quoted_amount are required",
      });
    }

    const assessment = await assessWithGeminiFlash({
      vehicle_make,
      vehicle_model,
      vehicle_year,
      service_name,
      quoted_amount,
      location_city,
      location_country,
      extra_notes,
    });

    if (persist_assessment) {
      const userId = req.user?._id || req.userId || null;
      const serviceKey = normalizeServiceKey(service_name);
      const doc = new ServicePriceSample({
        userId,
        vehicleId,
        serviceKey,
        label: service_name,
        qty: 1,
        unitPrice: Number(quoted_amount),
        total: Number(quoted_amount),
        vendor: null,
        city: location_city,
        region: location_country || "GLOBAL",
        currency: DEFAULT_CURRENCY, // force USD
        raw: {
          vehicle: { make: vehicle_make, model: vehicle_model, year: vehicle_year },
          ai: assessment,
          notes: extra_notes,
        },
      });
      await doc.save();
    }

    return res.json({ success: true, assessment });
  } catch (err) {
    const status = err?.status || 500;
    console.error(
      "[pricing] POST /assess-quote error:",
      err?.message || err,
      err?.raw ? `\nRAW: ${String(err.raw).slice(0, 400)}` : ""
    );
    return res.status(status).json({
      success: false,
      error:
        status === 503
          ? "AI not configured on the server. Set GEMINI_API_KEY."
          : err?.message || "assess-quote failed",
    });
  }
});

/**
 * POST /pricing/compare
 * Accepts batch items and returns AI judgments per line.
 * Currency in responses is always USD; legacy baseline_* fields are mapped from AI range.
 */
router.post("/compare", requireAuth, async (req, res) => {
  try {
    const {
      vehicle_make,
      vehicle_model,
      vehicle_year,
      // ignore incoming currency; always USD
      location_city = null,
      location_country = null,
      items = [],
    } = req.body || {};

    if (!vehicle_make || !vehicle_model || typeof vehicle_year !== "number") {
      return res
        .status(400)
        .json({ error: "vehicle_make, vehicle_model, vehicle_year are required" });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] required" });
    }

    const results = [];
    for (const it of items) {
      const service_name = it.label || it.key || "";
      const key = normalizeServiceKey(service_name);
      if (!key) continue;

      const qty = Math.max(1, Number(it.qty || 1));
      const unit = Number(it.price || it.unitPrice || 0);
      const total = Number.isFinite(Number(it.total)) ? Number(it.total) : qty * unit;

      if (!service_name || !Number.isFinite(total)) {
        results.push({
          key,
          label: service_name || key,
          qty,
          unitPrice: unit,
          total,
          verdict: "unknown",
          note: "Invalid service or price",
        });
        continue;
      }

      const assessment = await assessWithGeminiFlash({
        vehicle_make,
        vehicle_model,
        vehicle_year,
        service_name,
        quoted_amount: total,
        location_city,
        location_country,
        extra_notes: it.notes || null,
      });

      const aiMin = assessment?.inferred_fair_range?.min;
      const aiMax = assessment?.inferred_fair_range?.max;
      const mid =
        typeof aiMin === "number" && typeof aiMax === "number"
          ? (aiMin + aiMax) / 2
          : null;

      const deltaFromMid = mid != null ? total - mid : null;
      const deltaPct = mid ? (deltaFromMid / mid) * 100 : null;

      results.push({
        key,
        label: service_name,
        qty,
        unitPrice: unit,
        total,
        verdict: assessment.decision, // "fair" | "overpriced" | "unknown"
        ai: assessment,
        deltaFromMid,
        deltaPct,
      });
    }

    // Table for current UI (keeps legacy column names)
    const table = results.map((r) => {
      const aiMin = r.ai?.inferred_fair_range?.min ?? null;
      const aiMax = r.ai?.inferred_fair_range?.max ?? null;
      const mid =
        typeof aiMin === "number" && typeof aiMax === "number"
          ? Number(((aiMin + aiMax) / 2).toFixed(0))
          : null;

      return {
        service: r.label,
        qty: r.qty,
        user_unit: r.unitPrice,
        user_total: r.total,

        // legacy names (your table expects these)
        baseline_min: aiMin,
        baseline_avg: mid,
        baseline_max: aiMax,
        currency: DEFAULT_CURRENCY, // always USD
        verdict: r.verdict,
        delta_pct_vs_avg: r.deltaPct != null ? Number(r.deltaPct.toFixed(1)) : null,

        // explicit AI-named fields (if you want to switch later)
        ai_range_min: aiMin,
        ai_range_max: aiMax,
        ai_currency: DEFAULT_CURRENCY,
        ai_confidence: r.ai?.confidence ?? null,
        ai_verdict: r.verdict,
        delta_pct_vs_ai_mid: r.deltaPct != null ? Number(r.deltaPct.toFixed(1)) : null,
      };
    });

    return res.json({ success: true, results, table });
  } catch (err) {
    const status = err?.status || 500;
    console.error(
      "[pricing] POST /compare error:",
      err?.message || err,
      err?.raw ? `\nRAW: ${String(err.raw).slice(0, 500)}` : ""
    );
    return res.status(status).json({
      success: false,
      error:
        status === 503
          ? "AI not configured on the server. Set GEMINI_API_KEY."
          : err?.message || "compare failed",
    });
  }
});

/**
 * POST /pricing/submit
 * Keep crowd samples; currency saved as USD only.
 */
router.post("/submit", requireAuth, async (req, res) => {
  try {
    const { vehicleId = null, city = null, region = "GLOBAL", items = [] } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] required" });
    }

    const userId = req.user?._id || req.userId || null;
    const docs = [];
    for (const it of items) {
      const nk = normalizeServiceKey(String(it.key || it.label || ""));
      if (!nk) continue;
      const qty = Math.max(1, Number(it.qty || 1));
      const unit = Number(it.price || it.unitPrice || 0);
      const total = Number.isFinite(Number(it.total)) ? Number(it.total) : qty * unit;

      docs.push({
        userId,
        vehicleId,
        serviceKey: nk,
        label: it.label || nk,
        qty,
        unitPrice: unit,
        total,
        vendor: it.vendor || null,
        city,
        region,
        currency: DEFAULT_CURRENCY, // force USD
        raw: it,
      });
    }
    if (!docs.length) return res.status(400).json({ error: "no valid items to submit" });

    const inserted = await ServicePriceSample.insertMany(docs);
    return res.json({ success: true, inserted: inserted.length });
  } catch (err) {
    console.error("[pricing] POST /submit error:", err);
    return res.status(500).json({ success: false, error: "submit failed" });
  }
});

/**
 * GET /pricing/samples
 * Fetch recent crowd samples (for UI/history). Currency is USD in stored docs.
 */
router.get("/samples", requireAuth, async (req, res) => {
  try {
    const { serviceKey: rawKey = null, limit = 50, region = "GLOBAL", city = null } =
      req.query || {};
    const q = { region };
    if (rawKey) q.serviceKey = normalizeServiceKey(String(rawKey));
    if (city) q.city = city;

    const rows = await ServicePriceSample.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();
    return res.json({ success: true, items: rows });
  } catch (err) {
    console.error("[pricing] GET /samples error:", err);
    return res.status(500).json({ success: false, error: "samples failed" });
  }
});

export default router;
