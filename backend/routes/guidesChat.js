// backend/routes/guidesChat.js
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import requireAuth from "../middleware/requireAuth.js";
import GuidesChatSession from "../models/ChatSession.js";
import GuidesChatMessage from "../models/ChatMessage.js";

const router = express.Router();

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// One place for the assistant’s behavior:
const BASE_SYSTEM_PROMPT =
  "You are an automotive assistant for a mobile car app. Help users diagnose issues (sounds, lights, maintenance), explain OBD-II codes, suggest next steps, and warn when safety is involved. Keep answers concise, step-by-step, and actionable. If needed, ask one clarifying question. Avoid definitive claims without evidence.";

// Single Gemini client (SDK requires API key)
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
const geminiClient = hasGeminiKey ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Small helper to build a model with system instruction
function getModel(modelName = DEFAULT_MODEL) {
  if (!geminiClient) throw new Error("GEMINI_API_KEY missing");
  return geminiClient.getGenerativeModel({
    model: modelName,
    systemInstruction: BASE_SYSTEM_PROMPT,
  });
}

// Convert our DB history to Gemini contents (hide system messages)
function toGeminiContents(docs, maxTurns = 24) {
  const filtered = docs.filter((m) => m.role !== "system");
  // keep the last N messages for token safety
  const tail = filtered.slice(Math.max(0, filtered.length - maxTurns));
  return tail.map((m) =>
    m.role === "assistant"
      ? { role: "model", parts: [{ text: m.content }] }
      : { role: "user", parts: [{ text: m.content }] }
  );
}

/* ─────────────────────────────────────────────────────────
   Diagnostics
   ───────────────────────────────────────────────────────── */
router.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    hasGeminiKey,
    model: DEFAULT_MODEL,
  });
});

router.use(requireAuth);

/* ─────────────────────────────────────────────────────────
   Create a new chat session
   NOTE: no longer seeding a system message; we pass the
   system prompt via systemInstruction instead.
   ───────────────────────────────────────────────────────── */
router.post("/sessions", async (req, res) => {
  try {
    const userId = req.user._id;
    const title = (req.body?.title || "New chat").trim();
    const model = (req.body?.model || DEFAULT_MODEL).trim();

    const session = await GuidesChatSession.create({
      userId,
      title,
      model,
      lastMessagePreview: "",
    });

    return res.json({ success: true, session });
  } catch (err) {
    console.error("[guidesChat] create session error:", err);
    return res.status(500).json({ success: false, error: "failed_to_create_session" });
  }
});

/* ─────────────────────────────────────────────────────────
   List sessions
   ───────────────────────────────────────────────────────── */
router.get("/sessions", async (req, res) => {
  try {
    const userId = req.user._id;
    const sessions = await GuidesChatSession.find({ userId, archived: false })
      .sort({ updatedAt: -1 })
      .lean();
    return res.json({ success: true, sessions });
  } catch (e) {
    console.error("[guidesChat] list sessions error:", e);
    return res.status(500).json({ success: false });
  }
});

/* ─────────────────────────────────────────────────────────
   Patch session (rename/archive) – kept for compatibility
   ───────────────────────────────────────────────────────── */
router.patch("/sessions/:sessionId", async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const updates = {};
    if (typeof req.body?.title === "string") updates.title = req.body.title.trim();
    if (typeof req.body?.archived === "boolean") updates.archived = req.body.archived;

    const session = await GuidesChatSession.findOneAndUpdate(
      { _id: sessionId, userId },
      { $set: updates },
      { new: true }
    );

    if (!session) return res.status(404).json({ success: false, error: "not_found" });
    return res.json({ success: true, session });
  } catch (e) {
    console.error("[guidesChat] patch session error:", e);
    return res.status(500).json({ success: false });
  }
});

/* ─────────────────────────────────────────────────────────
   Delete session + messages
   ───────────────────────────────────────────────────────── */
router.delete("/sessions/:sessionId", async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;

    const sess = await GuidesChatSession.findOneAndDelete({ _id: sessionId, userId });
    if (!sess) return res.status(404).json({ success: false, error: "not_found" });

    await GuidesChatMessage.deleteMany({ sessionId, userId });
    return res.json({ success: true });
  } catch (e) {
    console.error("[guidesChat] delete session error:", e);
    return res.status(500).json({ success: false });
  }
});

/* ─────────────────────────────────────────────────────────
   List messages
   ───────────────────────────────────────────────────────── */
router.get("/sessions/:sessionId/messages", async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;

    const session = await GuidesChatSession.findOne({ _id: sessionId, userId });
    if (!session) return res.status(404).json({ success: false, error: "not_found" });

    const messages = await GuidesChatMessage.find({ sessionId, userId })
      .sort({ index: 1 })
      .lean();

    return res.json({ success: true, session, messages });
  } catch (e) {
    console.error("[guidesChat] list messages error:", e);
    return res.status(500).json({ success: false });
  }
});

/* ─────────────────────────────────────────────────────────
   Send a message + get assistant reply
   - Uses systemInstruction
   - Truncates history to last 24 messages
   - Retries once with minimal context
   - Auto-titles after first reply or if still "New chat"
   - Never 500s on AI failure (graceful fallback)
   ───────────────────────────────────────────────────────── */
router.post("/sessions/:sessionId/messages", async (req, res) => {
  const t0 = Date.now();
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const userText = (req.body?.content || "").toString().trim();
    if (!userText) return res.status(400).json({ success: false, error: "empty_message" });

    const session = await GuidesChatSession.findOne({ _id: sessionId, userId });
    if (!session) return res.status(404).json({ success: false, error: "not_found" });

    const countBefore = await GuidesChatMessage.countDocuments({ sessionId, userId });

    // 1) Save user message
    const userMsg = await GuidesChatMessage.create({
      sessionId,
      userId,
      role: "user",
      content: userText,
      index: countBefore,
    });

    // 2) Prepare history
    const historyDocs = await GuidesChatMessage.find({ sessionId, userId }).sort({ index: 1 }).lean();
    const contents = toGeminiContents(historyDocs, 24);

    const modelName = session.model || DEFAULT_MODEL;
    let replyText = "";

    // 3) Call Gemini with retry (minimal context fallback)
    try {
      const model = getModel(modelName);
      const result = await model.generateContent({
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
      });
      replyText = (result?.response?.text?.() ?? "").trim();
      if (!replyText) throw new Error("Empty Gemini response");
    } catch (err1) {
      console.warn("[guidesChat] Gemini attempt 1 failed:", err1?.message || err1);
      try {
        const model = getModel(modelName);
        const minimal = [
          contents.findLast?.((c) => c.role === "user") || { role: "user", parts: [{ text: userText }] },
        ];
        const result2 = await model.generateContent({
          contents: minimal,
          generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
        });
        replyText = (result2?.response?.text?.() ?? "").trim();
        if (!replyText) throw new Error("Empty Gemini response (retry)");
      } catch (err2) {
        console.error("[guidesChat] Gemini attempt 2 failed:", err2?.message || err2);
        replyText =
          "I’m having trouble reaching the assistant right now. Based on your question, here are quick next steps:\n\n" +
          "• If a warning light is on, note the color and whether it’s flashing.\n" +
          "• Describe when the issue happens (cold start, braking, turning, high speed).\n" +
          "• Share year/make/model, mileage, and any recent maintenance.\n\n" +
          "You can try again in a moment or add more details.";
      }
    }

    // 4) Save assistant message
    const assistantMsg = await GuidesChatMessage.create({
      sessionId,
      userId,
      role: "assistant",
      content: replyText,
      index: countBefore + 1,
    });

    // 5) Update preview
    await GuidesChatSession.updateOne(
      { _id: sessionId },
      { $set: { lastMessagePreview: replyText.slice(0, 160) } }
    );

    // 6) Auto-title (first assistant turn or if still "New chat")
    try {
      const needTitle = !session.title || /^new chat$/i.test(session.title);
      const isFirstAssistant = countBefore <= 0; // if you don't seed system, first user index=0
      if (needTitle || isFirstAssistant) {
        let newTitle = "";
        try {
          const model = getModel(modelName);
          const titlePrompt = [
            { role: "user", parts: [{ text: "Return a short, descriptive chat title (max 5 words). No quotes." }] },
            ...contents,
          ];
          const titleRes = await model.generateContent({
            contents: titlePrompt,
            generationConfig: { temperature: 0.2, maxOutputTokens: 16 },
          });
          newTitle = (titleRes?.response?.text?.() ?? "").trim();
        } catch {
          const firstUser = historyDocs.find((m) => m.role === "user");
          newTitle = (firstUser?.content || "Chat").split(/\s+/).slice(0, 6).join(" ");
        }
        if (newTitle) {
          await GuidesChatSession.updateOne({ _id: sessionId }, { $set: { title: newTitle } });
        }
      }
    } catch (titleErr) {
      console.warn("[guidesChat] auto-title failed:", titleErr?.message || titleErr);
    }

    console.log(`[guidesChat] replied in ${Date.now() - t0}ms`);
    return res.json({ success: true, user: userMsg, assistant: assistantMsg });
  } catch (e) {
    console.error("[guidesChat] send handler fatal:", e?.stack || e);
    // Final fallback: avoid 500 to keep UI flowing
    return res.json({
      success: true,
      user: null,
      assistant: {
        _id: `fallback-${Date.now()}`,
        sessionId: req.params.sessionId,
        userId: req.user?._id,
        role: "assistant",
        content: "Something went wrong on our side. Please try again in a moment.",
        index: -1,
      },
    });
  }
});

export default router;
