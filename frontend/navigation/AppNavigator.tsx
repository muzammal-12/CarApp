// navigation/AppNavigator.tsx
import * as React from "react";
import {
  ActivityIndicator,
  View,
  Text,
  Platform,
  Image,
} from "react-native";
import {
  NavigationContainer,
  DefaultTheme,
  InitialState,
} from "@react-navigation/native";
import * as ExpoSplash from "expo-splash-screen";

import { useAuth } from "../services/authContext";
import DrawerNavigator from "./DrawerNavigator";
import AuthNavigator from "./AuthNavigator";

// Keep native splash (iOS/Android) up until we explicitly hide it.
void ExpoSplash.preventAutoHideAsync().catch(() => {});

async function saveState(key: string, state: InitialState) {
  const data = JSON.stringify(state);
  if (Platform.OS === "web") {
    try { window.localStorage.setItem(key, data); } catch {}
    return;
  }
  const SecureStore = await import("expo-secure-store");
  try { await SecureStore.setItemAsync(key, data); } catch {}
}
async function loadState<T = InitialState | null>(key: string): Promise<T | null> {
  if (Platform.OS === "web") {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  }
  const SecureStore = await import("expo-secure-store");
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

/** Branded in-app splash (used at boot on web only) */
function Gate({ label = "Car-AI" }: { label?: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#ffffff",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      <Image
        source={require("../assets/images/splash-icon.png")}
        style={{ width: 96, height: 96 }}
        resizeMode="contain"
      />
      <Text style={{ fontSize: 20, fontWeight: "800", color: "#111827" }}>
        {label}
      </Text>
      <ActivityIndicator />
    </View>
  );
}

export default function AppNavigator() {
  const { ready, authed } = useAuth();

  // In-app splash at boot on web only (native uses the real splash).
  const [showGate, setShowGate] = React.useState(Platform.OS === "web");

  const stateKey = authed ? "navState_app" : "navState_auth";
  const [navReady, setNavReady] = React.useState(false);
  const [initialNavState, setInitialNavState] =
    React.useState<InitialState | undefined>(undefined);

  // Restore saved nav state after auth bootstrap is ready
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setNavReady(false);
      setInitialNavState(undefined);
      if (!ready) return;
      const saved = await loadState<InitialState>(stateKey);
      if (!cancelled) {
        setInitialNavState(saved ?? undefined);
        setNavReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authed]);

  // Hide native splash once both auth and nav are ready;
  // fade out the web gate once as well.
  React.useEffect(() => {
    if (ready && navReady) {
      const t = setTimeout(() => {
        void ExpoSplash.hideAsync().catch(() => {});
        if (Platform.OS === "web") setShowGate(false);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [ready, navReady]);

  // ⬇️ No special handling on logout anymore (no extra splash delay)

  // While bootstrapping, keep splash visible
  if (!ready || !navReady) return <Gate />;

  // If we’re showing the web gate at boot, render it
  if (showGate) return <Gate />;

  return (
    <NavigationContainer
      key={authed ? "app" : "auth"}
      theme={DefaultTheme}
      initialState={initialNavState}
      onStateChange={(state) => {
        if (state) saveState(stateKey, state).catch(() => {});
      }}
    >
      {authed ? <DrawerNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
