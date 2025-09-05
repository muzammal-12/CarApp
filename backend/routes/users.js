// backend/routes/users.js
import express from "express";
import User from "../models/User.js";
// If your auth middleware file is lowercase ("requireauth.js"), change the import below accordingly.
import requireAuth from "../middleware/requireAuth.js";

const router = express.Router();

// All routes require a valid JWT; middleware sets req.userId
router.use(requireAuth);

// GET /api/users/me  -> return current user profile
router.get("/me", async (req, res) => {
  const user = await User.findById(req.userId)
    .select("_id email firstName lastName phone")
    .lean();
  if (!user) return res.status(404).json({ msg: "User not found" });
  res.json(user);
});

// PATCH /api/users/me  -> update firstName/lastName/phone
router.patch("/me", async (req, res) => {
  const update = {};
  if (req.body.firstName !== undefined) update.firstName = String(req.body.firstName).trim();
  if (req.body.lastName !== undefined) update.lastName = String(req.body.lastName).trim();
  if (req.body.phone !== undefined) update.phone = String(req.body.phone).trim();

  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: update },
    { new: true, select: "_id email firstName lastName phone" }
  );

  if (!user) return res.status(404).json({ msg: "User not found" });
  res.json(user);
});

export default router;
