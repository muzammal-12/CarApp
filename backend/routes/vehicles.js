// backend/routes/vehicles.js
import express from "express";
import mongoose from "mongoose";
import Vehicle from "../models/Vehicle.js";
import requireAuth from "../middleware/requireAuth.js";
import cloudinary, {
  cloudinaryConfigured,
  deleteResourcesSafe,
  destroySafe,
} from "../utils/cloudinary.js";

const router = express.Router();

/* ─────────────────────────────────────────────────────────
   Middleware
   ───────────────────────────────────────────────────────── */
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requireAuth);

/* ─────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────── */

/**
 * ✅ Only oil_change is now tracked in last_maintenance.
 *    History can still log any items; predictions & hint use oil only.
 */
const KNOWN_KEYS = new Set(["oil_change"]);

/** Normalize any provided key to "oil_change" per new product rules (for last_maintenance/history seed). */
const normalizeKey = (raw = "") => {
  const s = String(raw).toLowerCase();
  if (s.includes("oil")) return "oil_change";
  // legacy inputs map to oil_change as we only keep this one
  return "oil_change";
};

/**
 * For SCHEDULING only: allow arbitrary services but map common ones to
 * consistent keys used by the app. Does NOT restrict to oil.
 */
const normalizeScheduleKey = (raw = "") => {
  const s = String(raw).toLowerCase();
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
  return s.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "service";
};

/** YYYY-MM-DD normalizer with ISO fallback */
const shortISO = (v) => {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
};

/**
 * Sanitize `last_maintenance` from the payload.
 * Only permits the `oil_change` object with (mileage, date).
 */
function sanitizeLastMaintenance(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const v = raw.oil_change;
  if (v && typeof v === "object") {
    const entry = {};
    if (v.mileage !== undefined) {
      const m = Number(v.mileage);
      if (Number.isFinite(m) && m >= 0) entry.mileage = m;
    }
    const d = shortISO(v.date);
    if (d) entry.date = d;
    if (Object.keys(entry).length) out.oil_change = entry;
  }
  return out;
}

/**
 * Compute a simple next-service hint based on oil change only.
 * Interval: 8,000 km or 12 months, whichever is sooner.
 * Uses dailyDriveKm (if present) to estimate a date from km delta.
 */
function computeNextServiceHint(v) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const currKm = Number(v.mileage || 0);
  const daily = Number(v.dailyDriveKm || 0) > 0 ? Number(v.dailyDriveKm) : null;

  const oil = (v.last_maintenance && v.last_maintenance.oil_change) || {};
  const baseKm = typeof oil.mileage === "number" ? oil.mileage : currKm;
  const nextAtKm = baseKm + 8000; // rule
  const dueKm = nextAtKm - currKm;

  const baseDateISO = shortISO(oil.date) || todayISO;
  const nextDateMS = new Date(baseDateISO).getTime() + 365 * 86400000; // 12 months
  const dueDaysByRule = Math.round((nextDateMS - today.getTime()) / 86400000);

  const dueDaysByKm = daily && typeof dueKm === "number" ? Math.ceil(dueKm / daily) : null;

  let chosenDays = null;
  let nextAtDateISO;
  if (dueDaysByRule !== null && dueDaysByKm !== null) {
    chosenDays = Math.min(dueDaysByRule, dueDaysByKm);
  } else {
    chosenDays = dueDaysByRule !== null ? dueDaysByRule : dueDaysByKm;
  }
  if (chosenDays !== null) {
    const d = new Date(today);
    d.setDate(d.getDate() + chosenDays);
    nextAtDateISO = d.toISOString().slice(0, 10);
  }

  const parts = [];
  if (typeof dueKm === "number") {
    parts.push(
      dueKm >= 0
        ? `in ~${dueKm.toLocaleString()} km`
        : `${Math.abs(dueKm).toLocaleString()} km overdue`
    );
  }
  if (nextAtDateISO) parts.push(`~${nextAtDateISO}`);

  v.next_service_hint = {
    key: "oil_change",
    mileage: nextAtKm,
    date: nextAtDateISO,
    note: parts.length ? `Likely due ${parts.join(" / ")}` : undefined,
  };
}

/* ─────────────────────────────────────────────────────────
   Vehicles CRUD
   ───────────────────────────────────────────────────────── */

router.get("/", async (req, res, next) => {
  try {
    const list = await Vehicle.find({ userId: req.userId })
      .sort({ isPrimary: -1, updatedAt: -1 })
      .lean();
    return res.json(list);
  } catch (e) {
    return next(e);
  }
});

router.get("/my", async (req, res, next) => {
  try {
    const list = await Vehicle.find({ userId: req.userId })
      .sort({ isPrimary: -1, updatedAt: -1 })
      .lean();
    return res.json(list);
  } catch (e) {
    return next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const {
      make, model, year, mileage, mileageUnit,
      name, nickname, isPrimary,
      vin, engine,
      dailyDriveKm,
      last_maintenance,
    } = req.body || {};

    if (!make || !model || year === undefined) {
      return res.status(400).json({ msg: "Make, model and year are required" });
    }

    const yearNum = Number(year);
    if (!Number.isFinite(yearNum) || yearNum < 1900 || yearNum > 2100) {
      return res.status(400).json({ msg: "Invalid year" });
    }

    const mileageNum = mileage === undefined ? undefined : Number(mileage);
    if (mileage !== undefined && !Number.isFinite(mileageNum)) {
      return res.status(400).json({ msg: "Invalid mileage" });
    }

    let unit;
    if (mileageUnit !== undefined) {
      const u = String(mileageUnit).toLowerCase();
      if (u !== "km" && u !== "mi") return res.status(400).json({ msg: "Invalid mileageUnit" });
      unit = u;
    }

    let dailyKm = undefined;
    if (dailyDriveKm !== undefined) {
      const dk = Number(dailyDriveKm);
      if (!Number.isFinite(dk) || dk < 0) return res.status(400).json({ msg: "Invalid dailyDriveKm" });
      dailyKm = dk;
    }

    const existingCount = await Vehicle.countDocuments({ userId: req.userId });
    if (isPrimary) {
      await Vehicle.updateMany({ userId: req.userId, isPrimary: true }, { $set: { isPrimary: false } });
    }

    const doc = await Vehicle.create({
      userId: req.userId,
      make: String(make).trim(),
      model: String(model).trim(),
      year: yearNum,
      mileage: mileageNum,
      mileageUnit: unit,
      name: name ? String(name).trim() : undefined,
      nickname: nickname ? String(nickname).trim() : undefined,
      vin: vin ? String(vin).trim() : undefined,
      engine: engine ? String(engine).trim() : undefined,
      isPrimary: !!isPrimary || existingCount === 0,
      dailyDriveKm: dailyKm,
      // ✅ only keep oil_change from payload
      last_maintenance: sanitizeLastMaintenance(last_maintenance),
    });

    // compute preview hint
    computeNextServiceHint(doc);
    await doc.save();

    return res.status(201).json(doc.toObject());
  } catch (e) {
    return next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "Invalid id" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    const setStr = (k) => {
      if (req.body[k] !== undefined) v[k] = String(req.body[k]).trim();
    };
    setStr("make");
    setStr("model");
    setStr("nickname");
    setStr("name");
    setStr("vin");
    setStr("engine");

    if (req.body.year !== undefined) {
      const y = Number(req.body.year);
      if (!Number.isFinite(y) || y < 1900 || y > 2100) return res.status(400).json({ msg: "Invalid year" });
      v.year = y;
    }

    if (req.body.mileage !== undefined) {
      const m = Number(req.body.mileage);
      if (!Number.isFinite(m) || m < 0) return res.status(400).json({ msg: "Invalid mileage" });
      v.mileage = m;
    }

    if (req.body.mileageUnit !== undefined) {
      const u = String(req.body.mileageUnit).toLowerCase();
      if (u !== "km" && u !== "mi") return res.status(400).json({ msg: "Invalid mileageUnit" });
      v.mileageUnit = u;
    }

    if (req.body.dailyDriveKm !== undefined) {
      const dk = Number(req.body.dailyDriveKm);
      if (!Number.isFinite(dk) || dk < 0) return res.status(400).json({ msg: "Invalid dailyDriveKm" });
      v.dailyDriveKm = dk;
    }

    // primary toggle
    if (req.body.isPrimary === true) {
      await Vehicle.updateMany({ userId: req.userId, _id: { $ne: id } }, { $set: { isPrimary: false } });
      v.isPrimary = true;
    } else if (req.body.isPrimary === false) {
      v.isPrimary = false;
    }

    // merge last_maintenance updates if provided (✅ oil only)
    if (req.body.last_maintenance) {
      const lm = sanitizeLastMaintenance(req.body.last_maintenance);
      v.last_maintenance = v.last_maintenance || {};
      if (lm.oil_change) {
        v.last_maintenance.oil_change = {
          ...(v.last_maintenance.oil_change || {}),
          ...lm.oil_change,
        };
      }
    }

    // recompute hint
    computeNextServiceHint(v);

    await v.save();
    return res.json(v.toObject());
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   NEW: Delete a vehicle (and its photos)
   ───────────────────────────────────────────────────────── */
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ msg: "Invalid id" });
    }

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    // Best-effort: remove Cloudinary photos
    let deletedPhotosCount = 0;
    const publicIds = (v.photos || [])
      .map((p) => p?.public_id)
      .filter(Boolean);

    if (publicIds.length) {
      try {
        // If bulk helper is available, use it; otherwise fall back to per-photo.
        if (typeof deleteResourcesSafe === "function") {
          const bulk = await deleteResourcesSafe(publicIds);
          // try to read count; otherwise just trust the list length
          deletedPhotosCount =
            Number(bulk?.deleted?.length || bulk?.resources_deleted?.length) ||
            publicIds.length;
        } else {
          for (const pid of publicIds) {
            try {
              await destroySafe(pid);
              deletedPhotosCount++;
            } catch {
              /* ignore per-photo failure */
            }
          }
        }
      } catch {
        // ignore cleanup failures, we still delete the DB record
      }
    }

    // Delete the vehicle document
    await Vehicle.deleteOne({ _id: id, userId: req.userId });

    // Ensure there is still one primary vehicle (optional nicety)
    const anyPrimary = await Vehicle.exists({ userId: req.userId, isPrimary: true });
    if (!anyPrimary) {
      const newest = await Vehicle.findOne({ userId: req.userId })
        .sort({ updatedAt: -1, createdAt: -1 });
      if (newest) {
        newest.isPrimary = true;
        await newest.save();
      }
    }

    return res.json({
      ok: true,
      deletedVehicleId: id,
      deletedPhotosCount,
    });
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   Primary toggle
   ───────────────────────────────────────────────────────── */
router.post("/:id/set-primary", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "Invalid id" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    await Vehicle.updateMany(
      { userId: req.userId, _id: { $ne: id } },
      { $set: { isPrimary: false } }
    );
    v.isPrimary = true;
    computeNextServiceHint(v);
    await v.save();
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   Photos
   ───────────────────────────────────────────────────────── */
router.post("/:id/photos", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "Invalid id" });

    const { public_id, url, width, height, bytes, format, created_at } = req.body || {};
    if (!public_id || !url) return res.status(400).json({ msg: "public_id and url are required" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    v.photos = v.photos || [];
    if (!v.photos.some((p) => p.public_id === public_id)) {
      v.photos.push({ public_id, url, width, height, bytes, format, created_at });
      await v.save();
    }
    return res.json(v.toObject());
  } catch (e) {
    return next(e);
  }
});

router.delete("/:id/photos", async (req, res, next) => {
  try {
    const { id } = req.params;
    const raw = req.query.publicId;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "Invalid id" });
    if (!raw) return res.status(400).json({ msg: "publicId query is required" });
    const publicId = decodeURIComponent(String(raw));

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    const exists = (v.photos || []).some((p) => p.public_id === publicId);
    if (!exists) return res.status(404).json({ msg: "Photo not found on this vehicle" });

    const cloudinaryResult = await destroySafe(publicId);
    v.photos = (v.photos || []).filter((p) => p.public_id !== publicId);
    await v.save();

    return res.json({ ok: true, vehicle: v.toObject(), cloudinary: cloudinaryResult });
  } catch (e) {
    return next(e);
  }
});

router.delete("/:id/photos/:publicId", async (req, res, next) => {
  try {
    const { id, publicId: rawId } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "Invalid id" });
    const publicId = decodeURIComponent(String(rawId));

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ msg: "Vehicle not found" });

    const exists = (v.photos || []).some((p) => p.public_id === publicId);
    if (!exists) return res.status(404).json({ msg: "Photo not found on this vehicle" });

    const cloudinaryResult = await destroySafe(publicId);
    v.photos = (v.photos || []).filter((p) => p.public_id !== publicId);
    await v.save();

    return res.json({ ok: true, vehicle: v.toObject(), cloudinary: cloudinaryResult });
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   Maintenance updater (bulk seed) – now oil only
   ───────────────────────────────────────────────────────── */
router.patch("/:id/maintenance", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const { updates, current_mileage } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ error: "updates[] required" });
    }

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    // This method now maps everything to oil_change internally
    v.applyMaintenanceUpdates(updates);

    if (current_mileage !== undefined) {
      const m = Number(current_mileage);
      if (Number.isFinite(m) && m >= 0) v.mileage = m;
    }

    computeNextServiceHint(v);
    await v.save();
    return res.json(v.toObject());
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   Maintenance history + completion
   ───────────────────────────────────────────────────────── */

// Get history (sorted desc by date)
router.get("/:id/maintenance-history", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId }).lean();
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    const hist = Array.isArray(v.maintenanceHistory) ? v.maintenanceHistory.slice() : [];
    hist.sort((a, b) => (b?.date || "").localeCompare(a?.date || ""));
    return res.json(hist);
  } catch (e) {
    return next(e);
  }
});

// Mark a maintenance item completed
router.post("/:id/maintenance/complete", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const { itemKey, date, mileage, cost, notes } = req.body || {};
    const key = normalizeKey(itemKey); // maps to "oil_change" for last_maintenance/history purposes
    const dateShort = shortISO(date);

    if (!itemKey || !dateShort) {
      return res.status(400).json({ error: "itemKey and date are required" });
    }

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    // write history + refresh seeds (Vehicle model handles oil-only seed)
    v.markMaintenanceCompleted({
      itemKey: key,
      date: dateShort,
      mileage: mileage !== undefined ? Number(mileage) : undefined,
      cost: cost !== undefined ? Number(cost) : undefined,
      notes: notes ? String(notes) : undefined,
    });

    // 🔸 Optional nicety: auto-remove a matching scheduled item (same key & date)
    if (Array.isArray(v.scheduledServices) && v.scheduledServices.length) {
      const before = v.scheduledServices.length;
      v.scheduledServices = v.scheduledServices.filter(
        (s) => !(String(s.itemKey) === String(normalizeScheduleKey(itemKey)) && String(s.dateISO).slice(0,10) === dateShort)
      );
      // no need to do anything with "after" count; save below will persist
    }

    computeNextServiceHint(v);
    await v.save();

    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

/* ─────────────────────────────────────────────────────────
   NEW: User-scheduled upcoming services (per-vehicle)
   ───────────────────────────────────────────────────────── */

/**
 * List scheduled services for a vehicle
 * GET /vehicles/:id/schedule
 */
router.get("/:id/schedule", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId }).lean();
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    const list = Array.isArray(v.scheduledServices) ? v.scheduledServices.slice() : [];
    list.sort((a, b) => (a?.dateISO || "").localeCompare(b?.dateISO || ""));
    return res.json(list);
  } catch (e) {
    return next(e);
  }
});

/**
 * Create a scheduled service
 * POST /vehicles/:id/schedule
 * Body: { service: string, itemKey?: string, dateISO: "YYYY-MM-DD", notes?: string }
 */
router.post("/:id/schedule", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const { service, itemKey, dateISO, notes } = req.body || {};
    const serviceStr = (service || "").toString().trim();
    const key = (itemKey && String(itemKey).trim()) || normalizeScheduleKey(serviceStr);
    const dateShort = shortISO(dateISO);

    if (!serviceStr || !dateShort) {
      return res.status(400).json({ error: "service and dateISO are required" });
    }

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    if (!Array.isArray(v.scheduledServices)) v.scheduledServices = [];
    v.scheduledServices.push({
      service: serviceStr,
      itemKey: key,
      dateISO: dateShort,
      notes: notes ? String(notes).trim() : undefined,
      createdAt: new Date(),
    });

    await v.save();
    // return the just-added subdoc
    const created = v.scheduledServices[v.scheduledServices.length - 1];
    return res.status(201).json(created);
  } catch (e) {
    return next(e);
  }
});

/**
 * Delete a scheduled service
 * DELETE /vehicles/:id/schedule/:sid
 */
router.delete("/:id/schedule/:sid", async (req, res, next) => {
  try {
    const { id, sid } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const v = await Vehicle.findOne({ _id: id, userId: req.userId });
    if (!v) return res.status(404).json({ error: "Vehicle not found" });

    const before = Array.isArray(v.scheduledServices) ? v.scheduledServices.length : 0;
    v.scheduledServices = (v.scheduledServices || []).filter((s) => String(s._id) !== String(sid));
    const after = v.scheduledServices.length;

    if (before === after) {
      return res.status(404).json({ error: "Scheduled item not found" });
    }

    await v.save();
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

export default router;
