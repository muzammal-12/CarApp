import mongoose from "mongoose";

const { Schema } = mongoose;

const PhotoSchema = new Schema(
  {
    public_id: { type: String, required: true },
    url: { type: String, required: true },
    width: Number,
    height: Number,
    bytes: Number,
    format: String,
    created_at: Date,
  },
  { _id: false }
);

const MaintUnitDateSchema = new Schema(
  {
    mileage: { type: Number, min: 0 },
    // store simple date (“YYYY-MM-DD”) – easy to interop with mobile inputs
    date: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * ✅ Only keep one last-maintenance slot now:
 *    - oil_change
 * (all other previous keys removed as per new product requirement)
 */
const LastMaintenanceSchema = new Schema(
  {
    oil_change: MaintUnitDateSchema,
  },
  { _id: false }
);

// Completed maintenance audit trail (history)
const MaintenanceHistoryItemSchema = new Schema(
  {
    itemKey: { type: String, required: true }, // e.g., "oil_change", "brake_pads"
    // Keep "YYYY-MM-DD" for easy RN interop; allow ISO too
    date: { type: String, required: true, trim: true },
    mileage: { type: Number, min: 0 },
    cost: { type: Number, min: 0 },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const NextServiceHintSchema = new Schema(
  {
    key: { type: String },      // e.g., "oil_change"
    mileage: { type: Number },  // next target mileage (if known)
    date: { type: String },     // estimated “YYYY-MM-DD” (if known)
    note: { type: String },     // short human message
  },
  { _id: false }
);

/**
 * ✅ NEW: user-created upcoming services (scheduler).
 * Stored per-vehicle and shown in the Upcoming section on the app.
 */
const ScheduledServiceSchema = new Schema(
  {
    service: { type: String, required: true, trim: true }, // human label, e.g., "Window repair"
    itemKey: { type: String, required: true, trim: true }, // normalized key used by app logic
    dateISO: { type: String, required: true, trim: true }, // "YYYY-MM-DD"
    notes: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true } // subdocs get their own ObjectId by default
);

const VehicleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1900, max: 2100 },

    // canonical stored mileage
    mileage: { type: Number, min: 0 },
    mileageUnit: { type: String, enum: ["km", "mi"], default: "km" },

    // average daily driving distance (km/day)
    dailyDriveKm: { type: Number, min: 0 },

    vin: { type: String, trim: true },
    engine: { type: String, trim: true },

    name: { type: String, trim: true },
    nickname: { type: String, trim: true },

    isPrimary: { type: Boolean, default: false },
    photos: { type: [PhotoSchema], default: [] },

    // ✅ only oil_change is retained
    last_maintenance: { type: LastMaintenanceSchema, default: {} },

    // server-computed quick preview of the next likely service
    next_service_hint: { type: NextServiceHintSchema, default: undefined },

    // full audit trail of completed services
    maintenanceHistory: { type: [MaintenanceHistoryItemSchema], default: [] },

    /**
     * ✅ NEW: upcoming user-scheduled services (shown under Upcoming -> "Scheduled (Your Picks)").
     * These do NOT modify last_maintenance until the user marks them completed.
     */
    scheduledServices: { type: [ScheduledServiceSchema], default: [] },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

VehicleSchema.index({ userId: 1, isPrimary: -1, updatedAt: -1 });

// Display name helpers
VehicleSchema.virtual("displayName").get(function () {
  return this.name || this.nickname || [this.year, this.make, this.model].filter(Boolean).join(" ");
});
VehicleSchema.virtual("display_name").get(function () {
  return this.displayName;
});

// Expose current_mileage as a virtual alias around stored `mileage`
VehicleSchema.virtual("current_mileage")
  .get(function () {
    return this.mileage ?? 0;
  })
  .set(function (val) {
    this.mileage = typeof val === "number" ? val : Number(val) || this.mileage || 0;
  });

/**
 * ✅ Only allow updating last_maintenance for oil_change.
 *    Any incoming key is normalized; if it looks like oil it maps to oil_change,
 *    otherwise we ignore it (by design).
 */
VehicleSchema.methods.applyMaintenanceUpdates = function (updates = []) {
  if (!this.last_maintenance) this.last_maintenance = {};
  const toOilKey = (raw = "") => {
    const s = String(raw).toLowerCase();
    // map anything that mentions oil to oil_change
    if (s.includes("oil")) return "oil_change";
    if (s === "oil_change") return "oil_change";
    return null; // ignore other keys by new rules
  };
  for (const u of updates) {
    if (!u || !u.key) continue;
    const key = toOilKey(u.key);
    if (!key) continue; // ignore non-oil updates
    if (!this.last_maintenance[key]) this.last_maintenance[key] = {};
    if (typeof u.mileage === "number") this.last_maintenance[key].mileage = u.mileage;
    if (u.date) this.last_maintenance[key].date = u.date;
  }
};

/**
 * Mark a maintenance item as completed:
 * - Always pushed to maintenanceHistory (any itemKey).
 * - For oil_change specifically, we also refresh last_maintenance.oil_change.
 */
VehicleSchema.methods.markMaintenanceCompleted = function ({
  itemKey,
  date,           // "YYYY-MM-DD" (or ISO; UI uses YYYY-MM-DD)
  mileage,        // optional
  cost,           // optional
  notes,          // optional
}) {
  if (!itemKey || !date) {
    throw new Error("itemKey and date are required to complete maintenance");
  }
  if (!this.maintenanceHistory) this.maintenanceHistory = [];
  this.maintenanceHistory.push({
    itemKey,
    date,
    mileage,
    cost,
    notes,
  });

  // Only update last_maintenance for oil change (as per new rules)
  const isOil = String(itemKey).toLowerCase().includes("oil");
  if (isOil) {
    if (!this.last_maintenance) this.last_maintenance = {};
    if (!this.last_maintenance.oil_change) this.last_maintenance.oil_change = {};
    this.last_maintenance.oil_change.date = date;
    if (typeof mileage === "number") this.last_maintenance.oil_change.mileage = mileage;
  }
};

export default mongoose.models.Vehicle || mongoose.model("Vehicle", VehicleSchema);
