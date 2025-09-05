// backend/models/ChatMessage.js
import mongoose from "mongoose";

const GuidesChatMessageSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "GuidesChatSession", index: true, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    role: { type: String, enum: ["system", "user", "assistant", "tool"], required: true },
    content: { type: String, required: true },
    metadata: { type: Object, default: {} },
    index: { type: Number, default: 0 },
  },
  { timestamps: true }
);

GuidesChatMessageSchema.index({ sessionId: 1, index: 1 });

const GuidesChatMessage = mongoose.model("GuidesChatMessage", GuidesChatMessageSchema);
export default GuidesChatMessage;
