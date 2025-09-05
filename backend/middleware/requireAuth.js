// backend/middleware/requireAuth.js
import jwt from "jsonwebtoken";

/**
 * Reads Bearer token from Authorization header, verifies it,
 * and sets req.userId AND req.user for downstream handlers.
 * Accepts payloads with { id } | { _id } | { userId } | { email, role }.
 */
export default function requireAuth(req, res, next) {
  // e.g. "Bearer eyJhbGciOi..."
  const hdr =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  // Robustly extract the token (handles extra spaces or missing "Bearer")
  const parts = String(hdr).trim().split(/\s+/);
  const token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : (parts[0] || "");

  if (!token) {
    return res.status(401).json({ msg: "Unauthorized: missing token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Normalize common payload shapes
    const id = decoded.userId || decoded.id || decoded._id;
    if (!id) {
      return res.status(401).json({ msg: "Unauthorized: bad token payload" });
    }

    // Expose both forms for different routes/controllers
    req.userId = id;
    req.user = {
      _id: id,
      id,
      email: decoded.email,   // optional if present in token
      role: decoded.role || "user",
    };

    return next();
  } catch (err) {
    return res.status(401).json({ msg: "Unauthorized: invalid token" });
  }
}
