import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { apiForgot } from "../../services/api";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

type Props = NativeStackScreenProps<RootStackParamList, "ForgotPassword">;

export default function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email) return Alert.alert("Missing", "Enter your email");
    try {
      setBusy(true);
      await apiForgot({ email: email.trim() });
      Alert.alert(
        "Check your email",
        "If the email exists, a reset link has been sent."
      );
      navigation.replace("Login");
    } catch (e: any) {
      Alert.alert("Failed", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <LinearGradient
      colors={["#1F2937", "#374151", "#4B5563"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.centerPad}
            keyboardShouldPersistTaps="handled"
          >
            {/* Brand */}
            <View style={styles.logoCircle}>
              <Feather name="key" size={26} color="#111827" />
            </View>

            <Text style={styles.pageTitle}>Forgot password?</Text>
            <Text style={styles.pageSub}>
              We’ll email you a reset link if your account exists.
            </Text>

            {/* Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Reset Password</Text>
              <Text style={styles.cardSub}>Enter the email you use to sign in</Text>

              <Text style={styles.label}>Email</Text>
              <View style={styles.inputRow}>
                <Feather name="mail" size={16} color="#CBD5E1" style={styles.inputIcon} />
                <TextInput
                  placeholder="your@email.com"
                  placeholderTextColor="#9CA3AF"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  returnKeyType="send"
                  onSubmitEditing={submit}
                  style={styles.input}
                />
              </View>

              <TouchableOpacity
                onPress={submit}
                disabled={busy}
                style={[styles.primaryBtn, busy && { opacity: 0.85 }]}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Send reset link</Text>
                )}
              </TouchableOpacity>

              <View style={styles.inlineRow}>
                <Text style={styles.muted}>Remembered it? </Text>
                <TouchableOpacity onPress={() => navigation.replace("Login")}>
                  <Text style={styles.link}>Back to log in</Text>
                </TouchableOpacity>
              </View>
            </View>
            {/* footer demo note removed */}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  centerPad: { padding: 24, paddingTop: 56, alignItems: "center" },

  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: "#E5E7EB",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },

  pageTitle: { fontSize: 22, fontWeight: "800", color: "#F9FAFB" },
  pageSub: { color: "#D1D5DB", marginTop: 4, marginBottom: 16, textAlign: "center" },

  // glass/dark card synced with bg
  card: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
  },
  cardTitle: {
    color: "#F9FAFB",
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
  },
  cardSub: { color: "#D1D5DB", fontSize: 12, textAlign: "center", marginTop: 2 },

  label: {
    color: "#E5E7EB",
    fontWeight: "700",
    fontSize: 12,
    marginTop: 12,
    marginBottom: 6,
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  inputIcon: { marginRight: 6 },
  input: { flex: 1, height: 44, color: "#F9FAFB" },

  primaryBtn: {
    backgroundColor: "#2563EB",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 14,
  },
  primaryBtnText: { color: "#FFFFFF", fontWeight: "800" },

  inlineRow: { flexDirection: "row", justifyContent: "center", marginTop: 10 },
  link: { color: "#93C5FD", fontWeight: "700" },
  muted: { color: "#D1D5DB" },
});
