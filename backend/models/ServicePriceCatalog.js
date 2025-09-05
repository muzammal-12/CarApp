// backend/models/ServicePriceCatalog.js
import mongoose from "mongoose";

/**
 * ServicePriceCatalog
 *
 * Stores baseline (curated) ranges and crowdsourced user quotes for
 * each normalized service key. Designed for global use (USD by default),
 * with optional region/city scoping.
 *
 * Updated for "AI (Gemini) decides" flow:
 * - Each user quote can carry an AI assessment snapshot:
 *   aiDecision ("fair" | "overpriced" | "unknown"), aiConfidence, aiRationale,
 *   aiRangeMin/aiRangeMax (optional inferred fair range), aiCurrency, aiModel.
 * - Lightweight rollups (fair/overpriced/unknown counts) kept in the doc for fast UI.
 *
 * Reading strategy (backwards compatible):
 * - If you still want statistical bands from userQuotes, use median/IQR.
 * - Otherwise, rely on stored AI decisions for recent quotes (your new flow).
 */

const UserQuoteSchema = new mongoose.Schema(
  {
    price: { type: Number, required: true }, // price in USD (default currency unless overridden)
    city: { type: String, default: null },   // e.g., "New York", "Dubai", "London"
    vehicleId: { type: String, default: null },
    userId: { type: String, default: null },
    notes: { type: String, default: null },
    at: { type: Date, default: Date.now },

    // ⬇️ NEW: AI (Gemini) assessment snapshot for THIS quote
    aiDecision: {
      type: String,
      enum: ["fair", "overpriced", "unknown"],
      default: "unknown",
    },
    aiConfidence: { type: Number, min: 0, max: 1, default: null },
    aiRationale: { type: String, default: null },
    aiRangeMin: { type: Number, default: null }, // inferred fair range (min)
    aiRangeMax: { type: Number, default: null }, // inferred fair range (max)
    aiCurrency: { type: String, default: "USD" },
    aiModel: { type: String, default: null },     // e.g., "gemini-1.5-pro"
    aiModelNotes: { type: String, default: null }, // optional short notes
  },
  { _id: false }
);

const BaseRangeSchema = new mongoose.Schema(
  {
    min: { type: Number, required: true },
    max: { type: Number, required: true },
    source: { type: String, default: "curated" }, // "curated" | "scraped" | "imported"
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ServicePriceCatalogSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, index: true, lowercase: true, trim: true }, // normalized key (e.g., "oil_change")
    label: { type: String, default: null }, // human label (e.g., "Oil Change")

    // Currency assumed USD for global deployment; override per-entry if needed.
    currency: { type: String, default: "USD" },

    // Optional “book time”/labor hours hint used by front-end when comparing quotes.
    standardHours: { type: Number, default: null },

    // Curated or imported baseline range (kept for backward compatibility).
    baseRange: { type: BaseRangeSchema, default: null },

    // Crowdsourced samples appended over time from user quotes.
    userQuotes: { type: [UserQuoteSchema], default: [] },

    // Convenience counters/rollups updated opportunistically:
    quotesCount: { type: Number, default: 0 },
    avgUserPrice: { type: Number, default: null }, // simple rolling average for quick display

    // ⬇️ NEW: AI rollups for quick UI filtering/metrics
    fairCount: { type: Number, default: 0 },
    overpricedCount: { type: Number, default: 0 },
    unknownCount: { type: Number, default: 0 },

    // Optional scoping for multi-region support
    region: { type: String, default: "GLOBAL" }, // region code or "GLOBAL"

    // ⬇️ NEW: last AI model/meta used for most recent assessment in this catalog
    lastAiModel: { type: String, default: null },
    lastAiAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Unique index on key within a region to avoid duplicates.
ServicePriceCatalogSchema.index({ region: 1, key: 1 }, { unique: true });

// Helpful secondary indexes
ServicePriceCatalogSchema.index({ updatedAt: -1 });
ServicePriceCatalogSchema.index({ "userQuotes.at": -1 });
// ⬇️ NEW: index to query by AI decisions quickly (e.g., list overpriced samples)
ServicePriceCatalogSchema.index({ "userQuotes.aiDecision": 1, "userQuotes.at": -1 });

/**
 * Internal helper: recompute simple rollups from userQuotes.
 * - quotesCount
 * - avgUserPrice
 * - fair/overpriced/unknown counts
 */
function recomputeRollups(doc) {
  const quotes = Array.isArray(doc.userQuotes) ? doc.userQuotes : [];
  doc.quotesCount = quotes.length;

  if (quotes.length > 0) {
    const sum = quotes.reduce((acc, q) => acc + (typeof q.price === "number" ? q.price : 0), 0);
    doc.avgUserPrice = Number.isFinite(sum / quotes.length) ? Math.round((sum / quotes.length) * 100) / 100 : null;
  } else {
    doc.avgUserPrice = null;
  }

  let fair = 0, over = 0, unk = 0;
  for (const q of quotes) {
    if (q.aiDecision === "fair") fair++;
    else if (q.aiDecision === "overpriced") over++;
    else unk++;
  }
  doc.fairCount = fair;
  doc.overpricedCount = over;
  doc.unknownCount = unk;
}

// Sanity guard: keep rollups in sync on save.
ServicePriceCatalogSchema.pre("save", function (next) {
  recomputeRollups(this);
  next();
});

// Optional: small convenience method to append a quote + AI snapshot atomically.
// (Use it from your route to keep the doc consistent without extra queries.)
ServicePriceCatalogSchema.methods.appendAiAssessedQuote = async function appendAiAssessedQuote({
  price,
  city = null,
  vehicleId = null,
  userId = null,
  notes = null,
  aiDecision = "unknown",
  aiConfidence = null,
  aiRationale = null,
  aiRangeMin = null,
  aiRangeMax = null,
  aiCurrency = "USD",
  aiModel = null,
  aiModelNotes = null,
  at = new Date(),
}) {
  this.userQuotes.push({
    price,
    city,
    vehicleId,
    userId,
    notes,
    at,
    aiDecision,
    aiConfidence,
    aiRationale,
    aiRangeMin,
    aiRangeMax,
    aiCurrency,
    aiModel,
    aiModelNotes,
  });

  // track last AI usage for quick reference
  this.lastAiModel = aiModel || this.lastAiModel;
  this.lastAiAt = new Date();

  recomputeRollups(this);
  return this.save();
};

const ServicePriceCatalog =
  mongoose.models.ServicePriceCatalog ||
  mongoose.model("ServicePriceCatalog", ServicePriceCatalogSchema);

export default ServicePriceCatalog;
