// backend/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { sendEmail } from "../utils/mailer.js";
import requireAuth from "../middleware/requireAuth.js";

const router = express.Router();
console.log("✅ Auth routes file loaded");

// Helpers
function normEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}
function normPass(raw) {
  return String(raw || "").trim();
}
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}
function buildUserLite(u) {
  if (!u) return null;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || undefined;
  return { id: u._id?.toString?.() ?? String(u._id), email: u.email, name, role: u.role || "user" };
}

// ───────────────────────────────────────────────────────────────────────────────
// Signup
router.post("/signup", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const password = normPass(req.body.password);

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ msg: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const verificationToken = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1d" });

    const user = new User({ email, password: hashed, verificationToken, isVerified: false });
    await user.save();

    const API_BASE = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`;
    const verifyLink = `${API_BASE}/api/auth/verify/${verificationToken}`;
    await sendEmail(email, "Verify Your Account", `<p>Click <a href="${verifyLink}">here</a> to verify.</p>`);

    return res.json({ msg: "Signup success. Check email to verify." });
  } catch (err) {
    console.error("[signup error]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Verify Email
router.get("/verify/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = normEmail(decoded.email);

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "Invalid token" });

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    return res.json({ msg: "Email verified successfully" });
  } catch (err) {
    console.error("[verify error]", err);
    return res.status(400).json({ msg: "Invalid or expired token" });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Login  ->  { token }
router.post("/login", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const password = normPass(req.body.password);

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    const user = await User.findOne({ email });
    console.log("[login] user found:", !!user, "verified:", user?.isVerified, "email:", email);

    if (!user) return res.status(400).json({ msg: "Invalid credentials" });
    if (!user.isVerified) return res.status(400).json({ msg: "Email not verified" });

    const isMatch = await bcrypt.compare(password, user.password);
    console.log("[login] password match:", isMatch);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const token = signToken({ id: user._id, email: user.email, role: user.role || "user" });
    return res.json({ token });
  } catch (err) {
    console.error("[login error]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Forgot Password (email link to API form)
router.post("/forgot-password", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    if (!email) return res.status(400).json({ msg: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });

    const resetToken = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const API_BASE = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`;
    const resetLink = `${API_BASE}/api/auth/reset/${resetToken}`;
    await sendEmail(email, "Reset Password", `<p>Click <a href="${resetLink}">here</a> to reset your password.</p>`);

    return res.json({ msg: "Reset link sent to email" });
  } catch (err) {
    console.error("[forgot-password error]", err);
    return res.status(500).json({ error: err.message });
  }
});

// Simple Reset Page (HTML)
router.get("/reset/:token", async (req, res) => {
  const { token } = req.params;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(400).send("<h3>Invalid or expired reset link.</h3>");
  }

  res.setHeader("Content-Type", "text/html");
  return res.send(`
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Reset Password</title></head>
  <body style="font-family: system-ui; max-width: 420px; margin: 40px auto;">
    <h2>Reset Password</h2>
    <form method="POST" action="/api/auth/reset/${token}">
      <div style="margin:12px 0">
        <label>New Password</label><br/>
        <input type="password" name="password" required style="width:100%;padding:10px"/>
      </div>
      <button type="submit" style="padding:10px 14px">Set New Password</button>
    </form>
  </body>
</html>
  `);
});

// Reset Password (handles HTML form post or JSON)
router.post("/reset/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const password = normPass(req.body.password);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = normEmail(decoded.email);

    const user = await User.findOne({
      email,
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });
    if (!user) return res.status(400).json({ msg: "Invalid or expired token" });

    user.password = await bcrypt.hash(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ msg: "Password reset successfully" });
  } catch (err) {
    console.error("[reset error]", err);
    return res.status(400).json({ msg: "Invalid or expired token" });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Session / Profile
// ───────────────────────────────────────────────────────────────────────────────

// NOTE: to satisfy the mobile `apiMe(token)` rehydration AND keep your existing
// ProfileScreen usage, we return BOTH:
//  - top-level profile fields (back-compat)
//  - a `user` object: { id, email, name?, role? } for session rehydration
router.get("/me", requireAuth, async (req, res) => {
  // requireAuth MUST set req.userId (and/or req.user.id). If your middleware sets `req.user._id`,
  // you can change the line below to `const dbId = req.user._id`.
  const dbId = req.userId || req.user?._id || req.user?.id;
  const user = await User.findById(dbId).lean();
  if (!user) return res.status(404).json({ msg: "User not found", user: null });

  const profile = {
    _id: user._id,
    email: user.email,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    phone: user.phone ?? "",
  };

  return res.json({
    ...profile,
    user: buildUserLite(user), // <-- new: for `apiMe()` in the app
  });
});

// PATCH /api/auth/me -> update profile fields (email not editable)
router.patch("/me", requireAuth, async (req, res) => {
  const dbId = req.userId || req.user?._id || req.user?.id;
  const patch = {
    ...(req.body.firstName !== undefined ? { firstName: String(req.body.firstName).trim() } : {}),
    ...(req.body.lastName !== undefined ? { lastName: String(req.body.lastName).trim() } : {}),
    ...(req.body.phone !== undefined ? { phone: String(req.body.phone).trim() } : {}),
  };

  const updated = await User.findOneAndUpdate(
    { _id: dbId },
    { $set: patch },
    { new: true, projection: { email: 1, firstName: 1, lastName: 1, phone: 1, role: 1 } }
  ).lean();

  if (!updated) return res.status(404).json({ msg: "User not found", user: null });

  const profile = {
    _id: updated._id,
    email: updated.email,
    firstName: updated.firstName ?? "",
    lastName: updated.lastName ?? "",
    phone: updated.phone ?? "",
  };

  return res.json({
    ...profile,
    user: buildUserLite(updated), // keep the session-friendly shape in responses
  });
});

// POST /api/auth/logout -> { ok: true }
router.post("/logout", requireAuth, (_req, res) => {
  // Stateless JWT: nothing to revoke unless you keep a denylist.
  return res.json({ ok: true });
});

export default router;
