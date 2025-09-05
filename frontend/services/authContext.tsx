// services/authContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiLogin, type LoginBody, apiMe, apiLogout } from "../services/api";
import {
  getToken as loadStoredToken,
  saveToken as persistToken,
  clearToken as clearStoredToken,
} from "../services/secure";

export type AuthContextType = {
  ready: boolean;
  authed: boolean;
  token: string | null;
  login: (body: LoginBody) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  // On startup: try to restore a persisted token and validate it
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const stored = await loadStoredToken();
        if (stored) {
          try {
            // Validate token against protected route
            await apiMe(stored);
            if (mounted) setToken(stored);
          } catch {
            // Invalid/expired -> wipe it
            await clearStoredToken();
          }
        }
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Login: call API, persist token, update state
  const login = async (body: LoginBody) => {
    const res = await apiLogin(body); // -> { token }
    await persistToken(res.token);
    setToken(res.token);
  };
 
  // Logout: best-effort notify server, then clear state + storage
  const logout = async () => {
    try {
      if (token) {
        await apiLogout(token).catch(() => {});
      }
    } finally {
      setToken(null);
      await clearStoredToken();
    }
  };

  const value = useMemo(
    () => ({ ready, authed: !!token, token, login, logout }),
    [ready, token]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
