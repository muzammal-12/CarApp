// backend/routes/inspections.js
import express from "express";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Inspection from "../models/Inspection.js";
import requireAuth from "../middleware/requireAuth.js";

/* === CATALOG: soft import (so code still runs if model not added yet) === */
let ServicePriceCatalog = null;
try {
  // you’ll add this file next
  const mod = await import("../models/ServicePriceCatalog.js");
  ServicePriceCatalog = mod.default || mod.ServicePriceCatalog || null;
} catch (e) {
  console.warn("[inspections] ServicePriceCatalog model not found yet; using heuristic fallback only.");
}

const router = express.Router();

/* ─────────── Config / Gemini init ─────────── */
const GEMINI_API_KEY =
  process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const ENABLE_GEMINI_SEARCH = String(process.env.ENABLE_GEMINI_SEARCH || "0") === "1";

if (!GEMINI_API_KEY) {
  console.warn("[inspections] GEMINI_API_KEY (or GOOGLE_GEMINI_API_KEY) is missing in .env");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/* ─────────── Helpers ─────────── */
function guessMime(url = "") {
  const low = url.toLowerCase();
  if (low.endsWith(".png")) return "image/png";
  if (low.endsWith(".webp")) return "image/webp";
  if (low.endsWith(".heic") || low.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

async function urlToInlineData(url) {
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  const mimeType = resp.headers["content-type"] || guessMime(url);
  const data = Buffer.from(resp.data).toString("base64");
  return { inlineData: { data, mimeType } };
}

/* ─────────── Prompts ─────────── */
function buildVehicleAwarePrompt({ partType, userNotes, vehicle, mode }) {
  const v = vehicle || {};
  const titleBits = [v?.year, v?.make, v?.model].filter(Boolean).join(" ");
  const title = titleBits || v?.name || "Unknown Vehicle";
  const mileageText =
    typeof v?.mileage === "number" ? `${v.mileage} ${v.mileageUnit || "km"}` : "unknown mileage";

  const WANT =
    mode === "tires"
      ? "tires, wheels, rims, tread close-ups, sidewalls, or a full tire on the car"
      : "automotive parts (brakes, rotors, belts, filters, hoses, engine bay, undercarriage), exterior body panels, lights, or visible damage on a vehicle";

  return `
You are an AI vehicle inspection assistant. Return STRICT JSON ONLY (no prose, no markdown fences).
Analyze ONLY ELIGIBLE vehicle-part images for this mode and ignore others.

OUTPUT (STRICT JSON):
{
  "part_type": "tire|brakes|belts|filters|rotors|hoses|engine|other",
  "per_image_findings": [
    {"image_index": 0, "issues": ["string"], "severity": "low|medium|high", "notes": "string"}
  ],
  "overall_assessment": "short human summary",
  "risk_level": "low|medium|high",
  "confidence": 0.0-1.0,
  "recommendations": ["string"],
  "warnings": ["string"],
  "estimated_urgency_days": 7
}

Guidance:
- TIRES: tread cues (estimate mm only if visible), uneven wear (inside/outside/cupping/feathering), cracking/bulges/sidewall damage, DOT/age if visible, overall condition.
- PARTS: brakes (pad thickness cues, rotor scoring), belts (fraying/glazing), filters, hoses, leaks, rust, body damage, lights if evident.
- Be conservative; if not visible, mark "unclear" or omit.

Vehicle:
- Title: ${title}
- Make/Model/Year: ${v?.make ?? "unknown"} ${v?.model ?? "unknown"} ${typeof v?.year === "number" ? v.year : "unknown"}
- Mileage: ${mileageText}
- Mode: ${String(mode || "").toUpperCase() || "PARTS"}
- Client intent (part_type): ${String(partType || "")}
- User notes: ${userNotes || "N/A"}
`.trim();
}

/* Tiny gate (separate model call) */
function buildGatePrompt(mode) {
  const want =
    mode === "tires"
      ? "tire/wheel/rim, tread close-up, sidewall, or a full tire on a vehicle"
      : "automotive parts (brakes, rotors, belts, filters, hoses, engine bay, undercarriage), exterior body panels, lights, or visible vehicle damage";
  return `
You are an image gatekeeper for automotive inspection.

Accept images that clearly show: ${want}.
Reject non-vehicle images (random objects, people, pets, scenery, food, UI screenshots, documents, receipts, text-only).

Return STRICT JSON ONLY:
{
  "eligible": [0,2],
  "rejected": [{"index":1,"reason":"not a vehicle part"}]
}
`.trim();
}

async function gatekeepImagesWithGemini({ imageUrls, mode }) {
  const gateModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const parts = [{ text: buildGatePrompt(mode) }, { text: "STRICT JSON only." }];
  for (let i = 0; i < imageUrls.length; i++) {
    parts.push({ text: `Image ${i}` });
    parts.push(await urlToInlineData(imageUrls[i]));
  }
  const gateRes = await gateModel.generateContent(parts);
  const gateText = (gateRes?.response?.text() || "").trim();
  const parsed = parseJsonFromModel(gateText) || {};
  const eligible = Array.isArray(parsed.eligible) ? parsed.eligible.filter(Number.isInteger) : [];
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];
  return { eligible, rejected };
}

function parseJsonFromModel(text) {
  const trimmed = (text || "").trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim()
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

function normalizeServiceKey(raw = "") {
  const s = raw.toLowerCase();
  if (s.includes("oil")) return "oil_change";
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

/* === Heuristic (existing) – used as ultimate fallback === */
function computeHeuristicRate(key, label) {
  const k = (key || "").toLowerCase();
  const TABLE = {
    oil_change:        { min: 40,  avg: 55,  max: 80,  hours: 0.5 },
    brake_pads:        { min: 100, avg: 225, max: 350, hours: 1.5 },
    rotors:            { min: 300, avg: 500, max: 700, hours: 1.8 },
    tires:             { min: 600, avg: 800, max: 1000, hours: 0.7 },
    air_filter:        { min: 25,  avg: 45,  max: 60,  hours: 0.2 },
    cabin_filter:      { min: 20,  avg: 40,  max: 60,  hours: 0.2 },
    coolant:           { min: 120, avg: 185, max: 250, hours: 1.0 },
    spark_plugs:       { min: 50,  avg: 80,  max: 120, hours: 1.2 },
    transmission_fluid:{ min: 130, avg: 185, max: 250, hours: 1.5 },
    battery:           { min: 120, avg: 185, max: 250, hours: 0.3 },
    wiper_blades:      { min: 20,  avg: 35,  max: 50,  hours: 0.1 },
  };

  let row =
    TABLE[k] ||
    (k.includes("rotor") ? TABLE.rotors : undefined) ||
    (k.includes("brake") ? TABLE.brake_pads : undefined) ||
    (k.includes("tire") || k.includes("tyre") ? TABLE.tires : undefined) ||
    (k.includes("cabin") ? TABLE.cabin_filter : undefined) ||
    (k.includes("air") && k.includes("filter") ? TABLE.air_filter : undefined) ||
    (k.includes("spark") ? TABLE.spark_plugs : undefined) ||
    (k.includes("transmission") ? TABLE.transmission_fluid : undefined) ||
    (k.includes("coolant") || k.includes("radiator") ? TABLE.coolant : undefined) ||
    (k.includes("battery") ? TABLE.battery : undefined) ||
    (k.includes("wiper") ? TABLE.wiper_blades : undefined);

  if (!row) row = { min: 120, avg: 180, max: 250, hours: 1.0 };

  return {
    key: k,
    label: label || k,
    avgPrice: Math.round(row.avg),
    rangeMin: Math.round(row.min),
    rangeMax: Math.round(row.max),
    standardHours: row.hours,
    currency: "USD",
    source: "heuristic",
  };
}

function deriveTyrePartsFromInspectionDoc(doc) {
  if (Array.isArray(doc?.items) && doc.items.length && doc.items[0]?.partName) {
    return doc.items;
  }
  const risk = doc?.geminiResponse?.risk_level || doc?.riskLevel;
  const map = { high: "urgent", medium: "worn", low: "good" };
  const status = map[(risk || "").toLowerCase()] || "worn";
  return [{ partName: "tires", status }];
}

/* === CATALOG: robust stats helpers (median / IQR band) === */
function median(nums) {
  if (!nums.length) return undefined;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function quantile(nums, q) {
  if (!nums.length) return undefined;
  const a = [...nums].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base] + (a[base + 1] !== undefined ? rest * (a[base + 1] - a[base]) : 0);
}

/* === CATALOG: get rates (catalog → baseRange → heuristic) === */
async function getCatalogRateForKey(key, label) {
  const k = normalizeServiceKey(key || label || "");
  try {
    if (ServicePriceCatalog) {
      const doc = await ServicePriceCatalog.findOne({ key: k }).lean();
      if (doc) {
        const currency = doc.currency || "PKR";
        const hours = typeof doc.standardHours === "number" ? doc.standardHours : undefined;

        // If we have enough user quotes, prefer robust band (IQR) around median
        const prices = (doc.userQuotes || []).map((q) => Number(q.price)).filter((n) => Number.isFinite(n) && n > 0);
        if (prices.length >= 5) {
          const med = median(prices);
          const p25 = quantile(prices, 0.25);
          const p75 = quantile(prices, 0.75);
          const bandMin = Math.max(0, Math.round(p25));
          const bandMax = Math.round(p75);
          return {
            key: k,
            label: doc.label || label || k,
            avgPrice: Math.round(med),
            rangeMin: bandMin,
            rangeMax: bandMax,
            standardHours: hours,
            currency,
            source: "catalog:user_quotes",
            quotesCount: prices.length,
          };
        }

        // Otherwise fall back to saved baseRange
        if (doc.baseRange?.min != null && doc.baseRange?.max != null) {
          const avg = Math.round((Number(doc.baseRange.min) + Number(doc.baseRange.max)) / 2);
          return {
            key: k,
            label: doc.label || label || k,
            avgPrice: avg,
            rangeMin: Number(doc.baseRange.min),
            rangeMax: Number(doc.baseRange.max),
            standardHours: hours,
            currency,
            source: "catalog:base_range",
            quotesCount: prices.length,
          };
        }
      }
    }
  } catch (e) {
    console.warn("[inspections] catalog lookup failed; using heuristic", e?.message);
  }
  // last resort
  return computeHeuristicRate(k, label);
}

/* === CATALOG: take a user quote and store it (learning) === */
async function upsertCatalogQuote(key, price, meta = {}) {
  if (!ServicePriceCatalog) return; // harmless if model not present yet
  const k = normalizeServiceKey(key);
  const p = Number(price);
  if (!k || !Number.isFinite(p) || p <= 0) return;

  const now = new Date();
  const safeMeta = {
    city: meta.city || null,
    vehicleId: meta.vehicleId || null,
    userId: meta.userId || null,
    notes: meta.notes || null,
    at: now,
  };

  const doc = await ServicePriceCatalog.findOneAndUpdate(
    { key: k },
    {
      $setOnInsert: {
        key: k,
        label: meta.label || k,
        currency: "PKR",
      },
      $push: { userQuotes: { price: p, ...safeMeta } },
      $inc: { quotesCount: 1 },
      $set: { updatedAt: now },
    },
    { upsert: true, new: true }
  );

  // Keep a simple rolling average (optional; robust band is computed at read time)
  if (doc) {
    const prices = (doc.userQuotes || []).map((q) => Number(q.price)).filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length) {
      const avg = prices.reduce((s, n) => s + n, 0) / prices.length;
      doc.avgUserPrice = Math.round(avg);
      await doc.save();
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  A) IMAGE INSPECTION (Gemini)
 * ────────────────────────────────────────────────────────────────────────────*/
router.post("/gemini", requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ success: false, message: "Gemini API key missing on server" });
  }

  const {
    partType,
    imageUrls,
    userNotes = "",
    vehicle = null,
    systemPrompt: clientSystemPrompt,
  } = req.body || {};

  if (!Array.isArray(imageUrls) || imageUrls.length === 0 || !partType) {
    return res
      .status(400)
      .json({ success: false, message: "partType and imageUrls[] are required" });
  }

  try {
    const userId = req.user?._id || req.userId;
    const mode = partType === "tire" || partType === "tires" ? "tires" : "parts";

    /* 1) Gate images first */
    let eligibleIdx = [];
    let rejectedMeta = [];
    try {
      const gate = await gatekeepImagesWithGemini({ imageUrls, mode });
      eligibleIdx = gate.eligible || [];
      rejectedMeta = Array.isArray(gate.rejected) ? gate.rejected : [];
    } catch (e) {
      console.error("[inspections] gate failed:", e?.response?.data || e);
      return res.status(400).json({
        success: false,
        code: "GATE_FAILED",
        message: "Could not verify photos. Please upload clear photos of the vehicle part or tires.",
      });
    }

    if (eligibleIdx.length === 0) {
      return res.status(400).json({
        success: false,
        code: "NO_ELIGIBLE_IMAGES",
        message:
          mode === "tires"
            ? "No eligible tire images detected. Please upload tire photos (tread close-ups and sidewalls, plus one wider view of the tire on the car)."
            : "No eligible vehicle-part images detected. Please upload clear photos of the relevant part (e.g., brakes, belts, engine bay, exterior damage).",
        rejected: rejectedMeta,
      });
    }

    const eligibleUrls = eligibleIdx.map((i) => imageUrls[i]);

    /* 2) Analysis on eligible only */
    const systemInstruction =
      typeof clientSystemPrompt === "string" && clientSystemPrompt.trim()
        ? clientSystemPrompt.trim()
        : buildVehicleAwarePrompt({ partType, userNotes, vehicle, mode });

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction });

    const parts = [
      { text: "Respond with STRICT JSON only." },
      { text: "Index images exactly as provided." },
    ];
    for (let i = 0; i < eligibleUrls.length; i++) {
      parts.push({ text: `Image ${i} (${partType})` });
      parts.push(await urlToInlineData(eligibleUrls[i]));
    }

    // Never leak a 500 to client for analysis hiccups
    let rawText;
    try {
      const result = await model.generateContent(parts);
      rawText = (result?.response?.text() || "").trim();
    } catch (err) {
      console.error("[inspections] gemini analysis failed:", err?.response?.data || err);
      return res.status(502).json({
        success: false,
        code: "ANALYSIS_FAILED",
        message:
          "We couldn’t analyze the photos right now. Please try again with clearer, well-lit pictures of the tire/part.",
      });
    }

    let parsed = parseJsonFromModel(rawText);
    if (!parsed) {
      parsed = {
        part_type: partType,
        per_image_findings: [],
        overall_assessment: rawText.slice(0, 4000),
        risk_level: "medium",
        confidence: 0.75,
        recommendations: [],
        warnings: [],
        estimated_urgency_days: 30,
      };
    }

    const summary = typeof parsed?.overall_assessment === "string" ? parsed.overall_assessment : "";
    let warnings = Array.isArray(parsed?.warnings) ? parsed.warnings : [];
    const confidence =
      typeof parsed?.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : undefined;
    const riskLevel = typeof parsed?.risk_level === "string" ? parsed.risk_level : undefined;

    // If some were rejected, add a concise warning (UI already renders warnings)
    if (rejectedMeta.length) {
      const note =
        "Some photos were ignored: " +
        rejectedMeta.map((r) => `#${r.index}${r.reason ? ` (${r.reason})` : ""}`).join(", ");
      warnings = Array.isArray(warnings) ? [...warnings, note] : [note];
    }

    const doc = await Inspection.create({
      userId,
      type: "tyres-parts",
      partType,
      mode,
      imageUrls, // keep originals
      userNotes,
      vehicle: vehicle || undefined,
      geminiModel: GEMINI_MODEL,
      geminiSystemPrompt: systemInstruction,
      geminiResponse: parsed,
      images: imageUrls.map((u) => ({ url: u })),
      summary,
      warnings,
      confidence,
      riskLevel,
    });

    const vehicleUsed = vehicle
      ? { name: vehicle.name ?? null, make: vehicle.make ?? null, model: vehicle.model ?? null }
      : null;

    console.log("[inspections] /gemini success", { id: doc._id, userId, eligible: eligibleIdx.length });
    return res.json({ success: true, inspection: doc, vehicleUsed });
  } catch (err) {
    console.error("[inspections] Gemini analysis error:", err?.response?.data || err);
    const msg = err?.message || err?.response?.data?.error?.message || "Gemini analysis failed";
    return res.status(500).json({ success: false, message: msg });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  B) LIST MINE
 * ────────────────────────────────────────────────────────────────────────────*/
router.get("/my", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const userId = req.user?._id || req.userId;
    const q = userId ? { userId } : {};
    const items = await Inspection.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    console.log("[inspections] /my", { userId, count: items.length });
    res.json({ success: true, items });
  } catch (err) {
    console.error("[inspections] /my error:", err);
    res.status(500).json({ success: false, message: "Failed to list inspections" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  C) TYRES/PARTS STATUS (for cross-checking quotes)
 * ────────────────────────────────────────────────────────────────────────────*/
router.get("/tyres-parts", requireAuth, async (req, res) => {
  try {
    const userId = req.user?._id || req.userId;
    const { vehicleId } = req.query || {};

    const base = { userId, type: "tyres-parts" };
    let q = base;
    if (vehicleId) {
      const vid = String(vehicleId);
      q = { ...base, $or: [{ vehicleId: vid }, { "vehicle._id": vid }] };
    }

    const latest = await Inspection.findOne(q).sort({ createdAt: -1 }).lean();
    if (!latest) {
      console.log("[inspections] /tyres-parts none", { userId, vehicleId });
      return res.json({ items: [] });
    }

    const items = deriveTyrePartsFromInspectionDoc(latest);
    console.log("[inspections] /tyres-parts hit", { userId, vehicleId, count: items.length });
    return res.json({ items });
  } catch (err) {
    console.error("[inspections] /tyres-parts error:", err);
    return res.status(500).json({ error: "tyres-parts failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  D) MARKET RATES (now uses catalog → heuristic)
 * ────────────────────────────────────────────────────────────────────────────*/
router.post("/market-rates", requireAuth, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] required" });
    }
    console.log("[inspections] /market-rates in", items);

    const mapped = await Promise.all(
      items.map(async (i) => {
        const key = normalizeServiceKey(i.key || i.label || "");
        const label = i.label || key;
        return getCatalogRateForKey(key, label);
      })
    );

    console.log("[inspections] /market-rates out", mapped);
    return res.json(mapped);
  } catch (err) {
    console.error("[inspections] /market-rates error:", err);
    return res.status(500).json({ error: "market-rates failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  E) AI QUOTE ANALYZE (unchanged from your version) 
 *     (front-end can stop calling this if you want pure catalog comparison)
 * ────────────────────────────────────────────────────────────────────────────*/
router.post("/ai/quote-analyze", requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Gemini API key missing on server" });
  }

  const payload = req.body || {};
  const {
    items = [],
    marketRates = [],
    tyresPartsStatus = [],
    vehicleSnapshot = {},
    ocrText = "",
    manualText = "",
    countryHint,
  } = payload;

  const logFail = (stage, err) => {
    console.error(`[inspections] /ai/quote-analyze ${stage} error:`, {
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
      data: err?.response?.data,
      status: err?.response?.status,
    });
  };

  const fallbackVerdict = () => {
    const overpriced_notes = [];
    const questionable_notes = [];
    const fair_notes = [];
    const negotiation_tips = [];
    const safety_critical = [];
    const defer_or_skip_suggestions = [];
    const notes = ["AI unavailable; used heuristic fallback"];

    try {
      const idx = {};
      for (const r of marketRates) idx[normalizeServiceKey(r.key || r.label || "")] = r;

      for (const it of items) {
        const k = normalizeServiceKey(it.key || it.label || "");
        const qty = Number(it.qty || 1);
        const price = Number(it.price || 0);
        const total = qty * price;
        const r = idx[k];
        if (r && typeof r.avgPrice === "number") {
          const high = r.avgPrice * 1.2;
          const low = r.avgPrice * 0.8;
          if (total > high) {
            overpriced_notes.push(`Likely overpriced: ${it.label || k} (${total.toFixed(0)} > ~${high.toFixed(0)})`);
          } else if (total < low) {
            fair_notes.push(`Below typical: ${it.label || k} (~${low.toFixed(0)}–${high.toFixed(0)})`);
          } else {
            fair_notes.push(`Within typical range: ${it.label || k}`);
          }
        } else {
          questionable_notes.push(`Unknown line: ${it.label || k} (${isFinite(total) ? `$${total.toFixed(0)}` : "no price"})`);
        }
      }

      negotiation_tips.push("Ask for parts/labor split and itemized fees.");
      negotiation_tips.push("Request tread depth/pad thickness before replacing wear items.");

      return {
        overpriced_notes,
        questionable_notes,
        fair_notes,
        negotiation_tips,
        defer_or_skip_suggestions,
        safety_critical,
        web_rates: [],
        notes,
      };
    } catch (e) {
      return {
        overpriced_notes,
        questionable_notes: ["Heuristic fallback ran into an error."],
        fair_notes,
        negotiation_tips,
        defer_or_skip_suggestions,
        safety_critical,
        web_rates: [],
        notes,
      };
    }
  };

  try {
    const KNOWN = new Set([
      "oil_change","brake_pads","rotors","tires","air_filter","cabin_filter",
      "coolant","spark_plugs","transmission_fluid","battery","wiper_blades"
    ]);
    const FEE_KEYS = new Set([
      "tax","subtotal","total","grand_total","shop_supplies","environmental_fee",
      "hazmat","fees","disposal","misc","sundries"
    ]);
    const normKey = (it) => normalizeServiceKey(it?.key || it?.label || "");
    const hoursIndex = {};
    for (const r of marketRates || []) {
      const k = normalizeServiceKey(r.key || r.label || "");
      if (typeof r.standardHours === "number") hoursIndex[k] = r.standardHours;
    }
    const unknownItems = (items || [])
      .map((it) => ({ ...it, _nk: normKey(it) }))
      .filter((it) => {
        const nk = it._nk || "";
        if (FEE_KEYS.has(nk)) return true;
        if (nk === "labor" || nk === "labour") return true;
        if (nk.includes("labor") || nk.includes("labour")) return true;
        return !KNOWN.has(nk);
      });

    const regionText = typeof countryHint === "string" ? countryHint : "US-avg";

    const sys = `
You are an automotive service advisor. Return STRICT JSON only (no markdown).
...`.trim();

    const prompt = `
REGION_HINT: ${regionText}
VEHICLE_SNAPSHOT: ${JSON.stringify(vehicleSnapshot || {})}
KNOWN_MARKET_RATES: ${JSON.stringify(marketRates || [])}
HOURS_HINTS_INDEX: ${JSON.stringify(hoursIndex)}
TYRES_OR_PARTS_STATUS: ${JSON.stringify(tyresPartsStatus || [])}
OCR_TEXT: ${JSON.stringify(ocrText || "")}
MANUAL_TEXT: ${JSON.stringify(manualText || "")}
ALL_ITEMS: ${JSON.stringify(items || [])}
UNKNOWN_OR_FEE_LIKE_ITEMS: ${JSON.stringify(unknownItems || [])}
`.trim();

    let model;
    if (ENABLE_GEMINI_SEARCH) {
      try {
        model = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          tools: [{ googleSearchRetrieval: {} }],
        });
        console.log("[inspections] /ai/quote-analyze using grounded model");
      } catch (e) {
        console.warn("[inspections] grounded model init failed; falling back");
        model = null;
      }
    }
    if (!model) model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    let text;
    try {
      const result = await model.generateContent([
        { text: sys },
        { text: "Respond in STRICT JSON only." },
        { text: prompt },
      ]);
      text = (result?.response?.text() || "").trim();
    } catch (err) {
      console.error("[inspections] /ai/quote-analyze generateContent error:", err);
      const fb = fallbackVerdict();
      return res.json({ gemini: fb, grounded: false, fallback: true });
    }

    const parsed = parseJsonFromModel(text) || {
      overpriced_notes: [],
      questionable_notes: [],
      fair_notes: [],
      negotiation_tips: [],
      defer_or_skip_suggestions: [],
      safety_critical: [],
      web_rates: [],
      notes: ["Model returned non-JSON; used default container."],
    };

    console.log("[inspections] /ai/quote-analyze ok");
    return res.json({ gemini: parsed, grounded: ENABLE_GEMINI_SEARCH, fallback: false });
  } catch (err) {
    const fb = fallbackVerdict();
    console.error("[inspections] /ai/quote-analyze outer error:", err);
    return res.json({ gemini: fb, grounded: false, fallback: true });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  F) SAVE QUOTE (maintenance-quote)  +  CATALOG LEARNING
 * ────────────────────────────────────────────────────────────────────────────*/
router.post("/quotes", requireAuth, async (req, res) => {
  try {
    const userId = req.user?._id || req.userId;
    const {
      vehicleId,
      summary,
      total,
      items,
      analysis,
      marketRates,
      rawText,
      ocrText,
      manualText,
      city,      // optional (PK context)
      currency,  // optional; default PKR
    } = req.body || {};

    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId required" });
    }

    const safeItems = Array.isArray(items) ? items : [];

    const combinedRaw =
      (typeof rawText === "string" && rawText.trim())
        ? rawText.trim()
        : [
            ocrText ? `OCR:\n${String(ocrText)}` : "",
            manualText ? `MANUAL:\n${String(manualText)}` : ""
          ].filter(Boolean).join("\n\n");

    if (!safeItems.length && !combinedRaw) {
      return res.status(400).json({ error: "Provide items[] or rawText/OCR text" });
    }

    const doc = await Inspection.create({
      userId,
      type: "maintenance-quote",
      vehicleId,
      summary: summary || `Quote ${new Date().toISOString()}`,
      total: typeof total === "number" ? total : undefined,
      items: safeItems,
      analysis,
      marketRates: Array.isArray(marketRates) ? marketRates : [],
      rawText: combinedRaw || undefined
    });

    // === CATALOG: learn from user quote lines
    try {
      await Promise.all(
        safeItems.map(async (it) => {
          const k = normalizeServiceKey(it.key || it.label || "");
          const price = Number(it.price || 0);
          if (!k || !Number.isFinite(price) || price <= 0) return;
          await upsertCatalogQuote(k, price, {
            label: it.label || k,
            city: city || null,
            vehicleId,
            userId,
            notes: `from saved quote ${doc._id}`,
          });
        })
      );
    } catch (e) {
      console.warn("[inspections] catalog upsert from quote failed:", e?.message);
    }

    return res.json(doc);
  } catch (err) {
    console.error("[inspections] /quotes error:", err);
    return res.status(500).json({ error: "save quote failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  G) QUOTE HISTORY (maintenance-quote)
 * ────────────────────────────────────────────────────────────────────────────*/
router.get("/maintenance/history", requireAuth, async (req, res) => {
  try {
    const userId = req.user?._id || req.userId;
    const { vehicleId } = req.query || {};

    const q = { userId, type: "maintenance-quote" };
    if (vehicleId) q.vehicleId = vehicleId;

    const rows = await Inspection.find(q).sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (err) {
    console.error("[inspections] /maintenance/history error:", err);
    return res.status(500).json({ error: "history failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 *  H) CATALOG ROUTES (read + add quote)
 * ────────────────────────────────────────────────────────────────────────────*/
router.get("/prices/:key", requireAuth, async (req, res) => {
  try {
    const key = normalizeServiceKey(req.params.key || "");
    if (!key) return res.status(400).json({ error: "invalid key" });

    if (!ServicePriceCatalog) {
      // no model present yet → return heuristic
      const h = computeHeuristicRate(key, key);
      return res.json({ source: "heuristic", entry: h });
    }

    const doc = await ServicePriceCatalog.findOne({ key }).lean();
    if (!doc) {
      const h = computeHeuristicRate(key, key);
      return res.json({ source: "heuristic", entry: h });
    }

    // compute robust band if enough user quotes
    const prices = (doc.userQuotes || []).map((q) => Number(q.price)).filter((n) => Number.isFinite(n) && n > 0);
    let fair = null;
    if (prices.length >= 5) {
      const med = median(prices);
      const p25 = quantile(prices, 0.25);
      const p75 = quantile(prices, 0.75);
      fair = { avg: Math.round(med), min: Math.round(p25), max: Math.round(p75), source: "catalog:user_quotes" };
    } else if (doc.baseRange?.min != null && doc.baseRange?.max != null) {
      fair = {
        avg: Math.round((Number(doc.baseRange.min) + Number(doc.baseRange.max)) / 2),
        min: Number(doc.baseRange.min),
        max: Number(doc.baseRange.max),
        source: "catalog:base_range",
      };
    }

    return res.json({
      source: fair?.source || "catalog",
      entry: {
        key: doc.key,
        label: doc.label,
        currency: doc.currency || "PKR",
        avgPrice: fair?.avg ?? doc.avgUserPrice ?? null,
        rangeMin: fair?.min ?? null,
        rangeMax: fair?.max ?? null,
        standardHours: doc.standardHours ?? null,
        quotesCount: prices.length,
      },
      raw: doc,
    });
  } catch (err) {
    console.error("[inspections] /prices/:key error:", err);
    return res.status(500).json({ error: "prices lookup failed" });
  }
});

router.post("/prices/add-quote", requireAuth, async (req, res) => {
  try {
    const userId = req.user?._id || req.userId;
    const { key, label, price, city, vehicleId, notes } = req.body || {};
    const k = normalizeServiceKey(key || label || "");
    const p = Number(price);

    if (!k || !Number.isFinite(p) || p <= 0) {
      return res.status(400).json({ error: "valid key and positive price required" });
    }
    await upsertCatalogQuote(k, p, { label, city, vehicleId, userId, notes });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[inspections] /prices/add-quote error:", err);
    return res.status(500).json({ error: "add-quote failed" });
  }
});

export default router;
