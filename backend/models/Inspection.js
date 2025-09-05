// backend/models/Inspection.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Subdocs
 */
const ImageSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String }, // optional (if you ever store it)
  },
  { _id: false }
);

// Snapshot of vehicle at inspection/quote time (keeps your original concept)
const VehicleSnapshotSchema = new Schema(
  {
    _id: { type: Schema.Types.Mixed }, // ObjectId or string
    name: { type: String },
    make: { type: String },
    model: { type: String },
    year: { type: Number },
    mileage: { type: Number },
    mileageUnit: { type: String, enum: ["km", "mi"] },
  },
  { _id: false }
);

// For tyres/parts status (e.g., from your Tyre & Parts check)
const PartStatusSchema = new Schema(
  {
    partName: { type: String, required: true },
    status: { type: String, enum: ["good", "worn", "urgent"], required: true },
    notes: { type: String },
  },
  { _id: false }
);

// For maintenance quote line items
const QuoteItemSchema = new Schema(
  {
    key: { type: String, required: true },   // normalized service key (e.g., "brake_pads")
    label: { type: String, required: true }, // display label shown to user
    part: { type: String },                  // optional part detail
    qty: { type: Number, default: 1 },
    price: { type: Number, required: true, min: 0 }, // total price for line
    laborHours: { type: Number, min: 0 },    // optional
    notes: { type: String },
  },
  { _id: false }
);

// For market reference used during analysis
const MarketRateSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    avgPrice: { type: Number, required: true },
    rangeMin: { type: Number, required: true },
    rangeMax: { type: Number, required: true },
    standardHours: { type: Number },
  },
  { _id: false }
);

// For analysis buckets (overpriced/questionable/fair)
const AnalysisSchema = new Schema(
  {
    overpriced: { type: [QuoteItemSchema], default: [] },
    questionable: { type: [QuoteItemSchema], default: [] },
    fair: { type: [QuoteItemSchema], default: [] },
  },
  { _id: false }
);

/**
 * Main Schema
 *
 * Supports:
 *  - Tyres/Parts inspections           -> type: "tyres-parts", items: PartStatusSchema[]
 *  - Maintenance quote analyses        -> type: "maintenance-quote", items: QuoteItemSchema[], analysis, marketRates, total, ocrText/manualText
 *  - Legacy/other                      -> type: "sound" | "general"
 */
const InspectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    // Optional pointer to a vehicle doc + an embedded snapshot
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", index: true },
    vehicle: { type: VehicleSnapshotSchema, default: null },

    // High-level discriminator for the record type
    type: {
      type: String,
      enum: ["tyres-parts", "maintenance-quote", "sound", "general"],
      default: "general",
      index: true,
    },

    // Legacy fields you already had / image inspection
    partType: { type: String }, // e.g., "tire", "brakes", "belts", "engine"
    mode: { type: String, enum: ["tires", "parts"], default: undefined },

    // Images (RELAXED: not required now, because quotes may be manual-only)
    imageUrls: [{ type: String }],
    images: { type: [ImageSchema], default: [] },

    // Notes from user
    userNotes: { type: String, default: "" },

    // Gemini bookkeeping
    geminiModel: { type: String, default: "gemini-1.5-flash" },
    geminiSystemPrompt: { type: String },
    geminiResponse: { type: Schema.Types.Mixed, default: {} },

    // Helpful derived fields (works for both inspections & quotes)
    summary: { type: String, default: "" },
    warnings: { type: [String], default: [] },
    confidence: { type: Number, min: 0, max: 1 },
    riskLevel: { type: String, enum: ["low", "medium", "high"], default: undefined },

    /**
     * Flexible "items" array:
     *  - tyres-parts: array of PartStatusSchema
     *  - maintenance-quote: array of QuoteItemSchema
     *  We intentionally allow both shapes; the frontend knows which to expect based on `type`.
     */
    items: { type: [Schema.Types.Mixed], default: [] },

    /**
     * Fields primarily used for maintenance quotes
     */
    total: { type: Number, min: 0 },            // grand total for the quote
    analysis: { type: AnalysisSchema, default: undefined },
    marketRates: { type: [MarketRateSchema], default: [] },
    ocrText: { type: String },                  // raw OCR text from image (if any)
    manualText: { type: String },               // raw manual lines entered by user
  },
  { timestamps: true }
);

/** Indexes */
InspectionSchema.index({ userId: 1, type: 1, createdAt: -1 });
InspectionSchema.index({ createdAt: -1 });
InspectionSchema.index({ "vehicle._id": 1 }); // NEW: speeds up queries that filter by embedded vehicle snapshot

/** Mirror embedded snapshot _id into vehicleId if missing (nice-to-have) */
InspectionSchema.pre("save", function (next) {
  try {
    if (!this.vehicleId && this.vehicle && this.vehicle._id) {
      try {
        this.vehicleId = new mongoose.Types.ObjectId(String(this.vehicle._id));
      } catch {
        // If it isn't a valid ObjectId, leave vehicleId undefined; fallback queries use vehicle._id
      }
    }
  } catch {
    // no-op
  }
  next();
});

const Inspection =
  mongoose.models.Inspection || mongoose.model("Inspection", InspectionSchema);

export default Inspection;
