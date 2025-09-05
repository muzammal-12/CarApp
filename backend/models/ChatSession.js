// backend/models/ChatSession.js
import mongoose from "mongoose";

const GuidesChatSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    title: { type: String, default: "New chat" },
    model: { type: String, default: process.env.GEMINI_MODEL || "gemini-1.5-flash" },
    archived: { type: Boolean, default: false },
    lastMessagePreview: { type: String, default: "" },
  },
  { timestamps: true }
);

GuidesChatSessionSchema.index({ userId: 1, updatedAt: -1 });

const GuidesChatSession = mongoose.model("GuidesChatSession", GuidesChatSessionSchema);
export default GuidesChatSession;
