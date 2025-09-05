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
import { apiSignup } from "../../services/api";
import { Feather, FontAwesome5 } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

type Props = NativeStackScreenProps<RootStackParamList, "Signup">;

export default function SignupScreen({ navigation }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !password) {
      Alert.alert("Missing", "Email and password are required");
      return;
    }
    try {
      setBusy(true);
      await apiSignup({ email: email.trim(), password });
      Alert.alert(
        "Verify your email",
        "A verification link was sent to your email. Please verify, then log in."
      );
      navigation.replace("Login");
    } catch (e: any) {
      Alert.alert("Signup failed", e?.message ?? "Unknown error");
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
        {/* icon-only back to splash */}
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.navigate("Welcome")}
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={18} color="#E5E7EB" />
        </TouchableOpacity>

        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.centerPad}
            keyboardShouldPersistTaps="handled"
          >
            {/* App mark */}
            <View style={styles.logoCircle}>
              <FontAwesome5 name="car" size={28} color="#111827" />
            </View>

            {/* Heading */}
            <Text style={styles.pageTitle}>Join CarCare Vista</Text>
            <Text style={styles.pageSub}>
              Create your account and start managing your vehicle
            </Text>

            {/* Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Create Account</Text>
              <Text style={styles.cardSub}>Fill in your details to get started</Text>

              {/* Email */}
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
                  returnKeyType="next"
                  style={styles.input}
                />
              </View>

              {/* Password */}
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputRow}>
                <Feather name="lock" size={16} color="#CBD5E1" style={styles.inputIcon} />
                <TextInput
                  placeholder="••••••••"
                  placeholderTextColor="#9CA3AF"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  style={styles.input}
                />
              </View>

              {/* Submit */}
              <TouchableOpacity
                onPress={submit}
                disabled={busy}
                style={[styles.primaryBtn, busy && { opacity: 0.85 }]}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Create Account</Text>
                )}
              </TouchableOpacity>

              {/* Switch to Login */}
              <View style={styles.inlineText}>
                <Text style={styles.muted}>Already have an account? </Text>
                <TouchableOpacity onPress={() => navigation.replace("Login")}>
                  <Text style={styles.link}>Sign in here</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  centerPad: { padding: 24, paddingTop: 56, alignItems: "center" },

  backBtn: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 5,
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

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
  pageSub: { color: "#D1D5DB", marginTop: 4, marginBottom: 16 },

  // glass/dark card in sync with bg
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

  inlineText: { flexDirection: "row", justifyContent: "center", marginTop: 12 },
  link: { color: "#93C5FD", fontWeight: "700" }, // lighter blue for dark bg
  muted: { color: "#D1D5DB" },
});
