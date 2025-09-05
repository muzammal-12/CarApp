// screens/guides/GuidesScreen.tsx
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Keyboard, // ⬅️ NEW
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../services/authContext";
import {
  apiGlcListSessions,
  apiGlcCreateSession,
  apiGlcLoadMessages,
  apiGlcSendMessage,
  apiGlcDeleteSession,
  type GLCChatMessage,
  type GLCChatSession,
} from "../../services/api";

type TabKey = "ask" | "history";

const POPULAR_QUESTIONS = [
  "What does the check engine light mean?",
  "How often should I change my oil?",
  "Why is my car making a squealing noise?",
  "What's the difference between summer and winter tires?",
];

const GuidesScreen: React.FC = () => {
  const { token } = useAuth();
  const [tab, setTab] = useState<TabKey>("ask");

  const [sessions, setSessions] = useState<GLCChatSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<GLCChatSession | null>(null);

  const [messages, setMessages] = useState<GLCChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<GLCChatMessage>>(null);

  const insets = useSafeAreaInsets();

  // ⬇️ NEW: track keyboard height on Android to float the composer
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = (e: any) => setKbHeight(e?.endCoordinates?.height ?? 0);
    const onHide = () => setKbHeight(0);
    const s1 = Keyboard.addListener(showEvt, onShow);
    const s2 = Keyboard.addListener(hideEvt, onHide);
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  /* ───────────────────────── Init ───────────────────────── */
  const refreshSessions = async () => {
    if (!token) return;
    try {
      const j = await apiGlcListSessions(token);
      if (j?.success) setSessions(j.sessions || []);
    } catch (e: any) {
      console.warn("[guides] list sessions failed:", e?.message || e);
    }
  };

  const ensureNewSessionIfNone = async () => {
    if (!token) return;
    await refreshSessions();
    if (sessions.length === 0) {
      const created = await apiGlcCreateSession(token, "New chat");
      if (created?.success) {
        setSessions([created.session]);
        setSelectedSession(created.session);
        await loadMessages(created.session);
      }
    }
  };

  useEffect(() => {
    (async () => {
      if (!token) return;
      await refreshSessions();
    })();
  }, [token]);

  useEffect(() => {
    (async () => {
      if (!token) return;
      if (!selectedSession) {
        const first = sessions?.[0];
        if (first) {
          setSelectedSession(first);
          await loadMessages(first);
        } else {
          await ensureNewSessionIfNone();
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, token]);

  /* ───────────────────── Session Ops ────────────────────── */
  const loadMessages = async (s: GLCChatSession) => {
    setLoading(true);
    try {
      const j = await apiGlcLoadMessages(token!, s._id);
      if (j?.success) setMessages(j.messages || []);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not load messages.");
    } finally {
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 150);
    }
  };

  const startNewChat = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await apiGlcCreateSession(token, "New chat");
      if (!r?.success) throw new Error("Create failed");
      await refreshSessions();
      setSelectedSession(r.session);
      setMessages([]);
      await loadMessages(r.session);
      setTab("ask");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not create chat.");
    } finally {
      setLoading(false);
    }
  };

  const resumeSession = async (s: GLCChatSession) => {
    setSelectedSession(s);
    await loadMessages(s);
    setTab("ask");
  };

  const deleteSession = async (s: GLCChatSession) => {
    try {
      await apiGlcDeleteSession(token!, s._id);
      await refreshSessions();
      if (selectedSession?._id === s._id) {
        const next = sessions.filter(x => x._id !== s._id)[0];
        if (next) await resumeSession(next);
        else await startNewChat();
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Delete failed");
    }
  };

  /* ───────────────────── Chat Send ──────────────────────── */
  const sendMessage = async (txt?: string) => {
    if (!selectedSession) return;
    const content = (txt ?? input).trim();
    if (!content) return;

    setInput("");
    setLoading(true);
    try {
      const optimistic: GLCChatMessage = {
        _id: `tmp-${Date.now()}`,
        sessionId: selectedSession._id,
        role: "user",
        content,
        index: messages.length,
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, optimistic]);

      const j = await apiGlcSendMessage(token!, selectedSession._id, content);
      if (!j?.success) throw new Error("Send failed");

      setMessages(prev => {
        const withoutTmp = prev.filter(m => m._id !== optimistic._id);
        return [...withoutTmp, j.user, j.assistant];
      });
      await refreshSessions();
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Message failed.");
    } finally {
      setLoading(false);
    }
  };

  const onTapPopular = (q: string) => void sendMessage(q);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined} // iOS uses padding; Android handled by kbHeight
      keyboardVerticalOffset={Platform.select({ ios: insets.top, android: 0, default: 0 })}
    >
      <SafeAreaView style={styles.root}>
        {/* Tabs */}
        <View style={styles.tabs}>
          <Pressable onPress={() => setTab("ask")} style={[styles.tabBtn, tab === "ask" && styles.tabActive]}>
            <Text style={[styles.tabText, tab === "ask" && styles.tabTextActive]}>Ask</Text>
          </Pressable>
          <Pressable onPress={() => setTab("history")} style={[styles.tabBtn, tab === "history" && styles.tabActive]}>
            <Text style={[styles.tabText, tab === "history" && styles.tabTextActive]}>History</Text>
          </Pressable>
        </View>

        {/* ASK SECTION */}
        {tab === "ask" && (
          <>
            <View style={styles.headerRow}>
              <Text numberOfLines={1} style={styles.title}>
                {selectedSession ? (selectedSession.title || "New chat") : "New chat"}
              </Text>
              <View style={styles.headerActions}>
                <Pressable onPress={startNewChat} style={[styles.smallBtn, styles.primaryBtn]}>
                  <Text style={[styles.smallBtnText, styles.primaryBtnText]}>New Chat</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.popularWrap}>
              <Text style={styles.popularTitle}>Popular Questions:</Text>
              <View style={styles.popularGrid}>
                {POPULAR_QUESTIONS.map((q) => (
                  <Pressable key={q} style={styles.popularChip} onPress={() => onTapPopular(q)}>
                    <Text style={styles.popularChipText}>{q}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.listWrap}>
              {loading && messages.length === 0 ? (
                <View style={styles.center}><ActivityIndicator /></View>
              ) : (
                <FlatList
                  ref={listRef}
                  data={messages.filter(m => m.role !== "system")}
                  keyExtractor={(m) => m._id}
                  renderItem={({ item }) => (
                    <View style={[styles.bubble, item.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}>
                      <Text style={styles.bubbleText}>{item.content}</Text>
                    </View>
                  )}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                  // ⬇️ add space equal to composer + safe area + current keyboard height (Android)
                  contentContainerStyle={{
                    padding: 12,
                    paddingBottom: (insets.bottom || 0) + 88 + (Platform.OS === "android" ? kbHeight + 16: 0),
                  }}
                  onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
                />
              )}
            </View>

            {/* Composer */}
            <View
              style={[
                styles.composer,
                { paddingBottom: Math.max(insets.bottom, 8) },
                // ⬇️ NEW: float above Android keyboard reliably
                Platform.OS === "android" ? { marginBottom: kbHeight + 16} : null,
              ]}
            >
              <TextInput
                placeholder="Ask me anything about your car…"
                placeholderTextColor="#6b7280"
                value={input}
                onChangeText={setInput}
                style={styles.input}
                multiline
              />
              <Pressable
                onPress={() => sendMessage()}
                disabled={!selectedSession || !input.trim() || loading}
                style={[styles.askBtn, (!selectedSession || !input.trim() || loading) && styles.askBtnDisabled]}
              >
                <Text style={styles.askBtnText}>{loading ? "..." : "Ask"}</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* HISTORY SECTION */}
        {tab === "history" && (
          <View style={styles.historyWrap}>
            {sessions.length === 0 ? (
              <View style={styles.center}><Text style={styles.muted}>No chats yet.</Text></View>
            ) : (
              <FlatList
                data={sessions}
                keyExtractor={(s) => s._id}
                renderItem={({ item }) => (
                  <Pressable style={styles.historyItem} onPress={() => resumeSession(item)}>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={styles.historyTitle}>
                        {item.title || "Untitled chat"}
                      </Text>
                      {!!item.lastMessagePreview && (
                        <Text numberOfLines={1} style={styles.historyPreview}>
                          {item.lastMessagePreview}
                        </Text>
                      )}
                    </View>
                    <View style={styles.historyActions}>
                      <Pressable onPress={() => deleteSession(item)} style={[styles.actionChip, styles.dangerChip]}>
                        <Text style={[styles.actionChipText, styles.dangerChipText]}>Delete</Text>
                      </Pressable>
                    </View>
                  </Pressable>
                )}
                ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
                contentContainerStyle={{ padding: 12, paddingBottom: (insets.bottom || 0) + 8 }}
                keyboardShouldPersistTaps="handled"
              />
            )}
          </View>
        )}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f7fb" },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  tabBtn: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e6e9f2",
  },
  tabActive: { backgroundColor: "#eef2ff", borderColor: "#c8d2ff" },
  tabText: { color: "#5b6170", fontWeight: "600" },
  tabTextActive: { color: "#1b2a6b" },

  headerRow: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: "#0f172a", fontSize: 16, fontWeight: "700", flex: 1, paddingRight: 8 },
  headerActions: { flexDirection: "row", gap: 8 },
  smallBtn: { backgroundColor: "#e9edf8", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  smallBtnText: { color: "#0f1b4b", fontWeight: "600" },
  primaryBtn: { backgroundColor: "#3a6df0" },
  primaryBtnText: { color: "#fff" },

  popularWrap: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 },
  popularTitle: { color: "#0f172a", marginBottom: 8, fontWeight: "700" },
  popularGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  popularChip: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e6e9f2",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    maxWidth: "48%",
  },
  popularChipText: { color: "#111827" },

  listWrap: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: "#6b7280" },

  bubble: { marginVertical: 6, padding: 10, borderRadius: 10 },
  bubbleUser: { backgroundColor: "#e8efff", alignSelf: "flex-end", maxWidth: "85%" },
  bubbleAssistant: {
    backgroundColor: "#ffffff",
    alignSelf: "flex-start",
    maxWidth: "90%",
    borderWidth: 1,
    borderColor: "#eef1f6",
  },
  bubbleText: { color: "#111827", fontSize: 15, lineHeight: 20 },

  composer: {
    paddingTop: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-end",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e6e9f2",
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    backgroundColor: "#f3f4f6",
    color: "#111827",
    padding: 10,
    borderRadius: 8,
  },
  askBtn: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: "#111827", borderRadius: 8 },
  askBtnDisabled: { opacity: 0.5 },
  askBtnText: { color: "#ffffff", fontWeight: "700" },

  historyWrap: { flex: 1 },
  historyItem: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e6e9f2",
  },
  historyTitle: { color: "#0f172a", fontWeight: "700" },
  historyPreview: { color: "#6b7280", marginTop: 4 },
  historyActions: { flexDirection: "row", gap: 8 },
  actionChip: { backgroundColor: "#f3f4f6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  actionChipText: { color: "#374151", fontWeight: "600" },
  dangerChip: { backgroundColor: "#fde8e8" },
  dangerChipText: { color: "#991b1b" },
});

export default GuidesScreen;
