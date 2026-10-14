import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api, ApiError, REFRESH_TOKEN_KEY } from './api';

interface AuthState {
  ready: boolean;
  user: any | null;
  requestOtp: (phone: string) => Promise<{ devOtp?: string; retryAfter?: number | null }>;
  verifyOtp: (phone: string, otp: string) => Promise<{ registrationRequired: boolean; phone: string }>;
  register: (phone: string, otp: string, fullName: string) => Promise<void>;
  logout: () => Promise<void>;
  forceLogin: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<any | null>(null);

  // Session restore on boot: the stored refresh token either mints a pair or is dead.
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
        if (stored) {
          const data = await api.request('POST', '/auth/refresh', { body: { refreshToken: stored }, auth: false });
          api.setAccessToken(data.tokens.accessToken);
          await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.tokens.refreshToken);
          const me = await api.get('/auth/me');
          setUser(me.user);
        }
      } catch {
        await api.signOutLocal();
      } finally {
        setReady(true);
      }
    })();
    api.onAuthLost = () => setUser(null);
    return () => {
      api.onAuthLost = null;
    };
  }, []);

  async function applySession(data: any) {
    api.setAccessToken(data.tokens.accessToken);
    // Refresh token → Keychain/Keystore, per the mobile contract. Never plain storage.
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.tokens.refreshToken);
    setUser(data.user);
  }

  const value: AuthState = {
    ready,
    user,
    async requestOtp(phone: string) {
      try {
        const data = await api.request('POST', '/auth/otp/request', { body: { phone }, auth: false });
        return { devOtp: data.devOtp };
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          return { retryAfter: e.retryAfter };
        }
        throw e;
      }
    },
    async verifyOtp(phone: string, otp: string) {
      const data = await api.request('POST', '/auth/otp/verify', { body: { phone, otp }, auth: false });
      if (data.registrationRequired) return { registrationRequired: true, phone: data.phone ?? phone };
      await applySession(data);
      return { registrationRequired: false, phone };
    },
    async register(phone: string, otp: string, fullName: string) {
      const data = await api.request('POST', '/auth/register', {
        body: { phone, otp, role: 'customer', fullName },
        auth: false,
      });
      await applySession(data);
    },
    async logout() {
      try {
        const stored = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
        if (stored) {
          await api.request('POST', '/auth/logout', { body: { refreshToken: stored } }).catch(() => null);
        }
      } finally {
        await api.signOutLocal();
        setUser(null);
      }
    },
    forceLogin() {
      setUser(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
