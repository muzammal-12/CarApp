// screens/auth/WelcomeScreen.tsx
import React, { useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ScrollView,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import type { AuthStackParamList } from "@/navigation/AuthNavigator";

type Nav = NativeStackNavigationProp<AuthStackParamList, "Welcome">;

export default function WelcomeScreen() {
  const navigation = useNavigation<Nav>();

  useEffect(() => {
    // optional auto-redirect:
    // const t = setTimeout(() => navigation.navigate("Login"), 3000);
    // return () => clearTimeout(t);
  }, [navigation]);

  return (
    <View style={styles.root}>
      {/* grey/slate gradient background */}
      <LinearGradient
        colors={["#1f2937", "#334155", "#64748b"]} // gray-800 → slate-700 → slate-500
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Make page scrollable on small screens & web */}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Ionicons name="car-sport" size={64} color="#fff" />
        </View>

        {/* Title & tagline */}
        <Text style={styles.title}>CarCare Pro</Text>
        <Text style={styles.tagline}>
          Your smart companion for car maintenance, repairs, and diagnostics
        </Text>

        {/* Feature tiles */}
        <View style={styles.grid}>
          <View style={styles.tile}>
            <Ionicons name="construct" size={32} color="#fff" style={styles.tileIcon} />
            <Text style={styles.tileTitle}>Smart Diagnostics</Text>
            <Text style={styles.tileSub}>AI-powered tire, part, and sound analysis</Text>
          </View>

          <View style={styles.tile}>
            <Ionicons name="shield-checkmark" size={32} color="#fff" style={styles.tileIcon} />
            <Text style={styles.tileTitle}>Maintenance Tracking</Text>
            <Text style={styles.tileSub}>Never miss scheduled maintenance again</Text>
          </View>

          <View style={styles.tile}>
            <Ionicons name="people" size={32} color="#fff" style={styles.tileIcon} />
            <Text style={styles.tileTitle}>Shop Network</Text>
            <Text style={styles.tileSub}>Compare quotes from trusted mechanics</Text>
          </View>
        </View>

        {/* CTAs */}
        <View style={styles.ctaCol}>
          <Pressable
            onPress={() => navigation.navigate("Signup")}
            style={({ pressed }) => [styles.btnPrimaryLight, pressed && { opacity: 0.9 }]}
          >
            <Text style={styles.btnPrimaryLightText}>Get Started</Text>
          </Pressable>

          <Pressable
            onPress={() => navigation.navigate("Login")}
            style={({ pressed }) => [styles.btnOutline, pressed && { opacity: 0.9 }]}
          >
            <Text style={styles.btnOutlineText}>Sign In</Text>
          </Pressable>
        </View>

        {/* Guest (optional) */}
        <Pressable
          onPress={() => navigation.navigate("Login")}
          style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.btnGhostText}>Continue as Guest</Text>
        </Pressable>

        {/* Pulsing dots */}
        <View style={styles.dotsRow}>
          <View style={[styles.dot, styles.dotA]} />
          <View style={[styles.dot, styles.dotB]} />
          <View style={[styles.dot, styles.dotC]} />
        </View>

        {/* add bottom padding so last item isn’t cut off */}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1f2937" }, // fallback color
  scrollContent: {
    minHeight: "100%",
    paddingHorizontal: 24,
    paddingTop: 80,
    paddingBottom: 32,
    alignItems: "center",
  },

  logoWrap: {
    backgroundColor: "rgba(255,255,255,0.10)",
    padding: 24,
    borderRadius: 999,
    marginBottom: 24,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 4 },
    }),
  },

  title: { fontSize: 36, fontWeight: "800", color: "#fff", textAlign: "center", marginBottom: 8 },
  tagline: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 16,
    textAlign: "center",
    maxWidth: 340,
    marginBottom: 28,
  },

  grid: {
    width: "100%",
    maxWidth: 860,
    gap: 12,
    marginBottom: 28,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  tile: {
    backgroundColor: "rgba(255,255,255,0.09)", // slightly dimmer than before
    borderRadius: 16,
    padding: 16,
    width: 280,
    marginHorizontal: 6,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 3 },
    }),
  },
  tileIcon: { alignSelf: "center", marginBottom: 8 },
  tileTitle: { color: "#fff", textAlign: "center", fontWeight: "700", marginBottom: 6 },
  tileSub: { color: "rgba(255,255,255,0.85)", textAlign: "center", fontSize: 12 },

  ctaCol: { width: "100%", maxWidth: 360, gap: 12, marginTop: 12, marginBottom: 10 },

  btnPrimaryLight: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnPrimaryLightText: { color: "#1D4ED8", fontWeight: "700", fontSize: 16 },

  btnOutline: {
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.95)",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnOutlineText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  btnGhost: { marginTop: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  btnGhostText: { color: "rgba(255,255,255,0.8)", fontWeight: "600" },

  dotsRow: { flexDirection: "row", gap: 8, marginTop: 18 },
  dot: { width: 8, height: 8, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.7)" },
  dotA: { opacity: 0.6 },
  dotB: { opacity: 0.6 },
  dotC: { opacity: 0.6 },
});
