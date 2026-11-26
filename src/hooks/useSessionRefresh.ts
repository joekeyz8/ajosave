"use client";

import { useSession, signOut } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";

export interface UseSessionRefreshReturn {
  /** Time in milliseconds until session expires, or null if no session */
  timeUntilExpiry: number | null;
  /** Manually trigger a session refresh */
  refreshSession: () => Promise<void>;
}

/**
 * Silently refreshes the JWT before the access token expires.
 * Drop this hook into any layout that requires authentication.
 */
export function useSessionRefresh(): UseSessionRefreshReturn {
  const { data: session } = useSession();
  const [timeUntilExpiry, setTimeUntilExpiry] = useState<number | null>(null);

  const refreshSession = useCallback(async () => {
    const { getSession } = await import("next-auth/react");
    await getSession();
  }, []);

  useEffect(() => {
    if (!session) {
      setTimeUntilExpiry(null);
      return;
    }

    // Force logout if refresh token has expired
    if ((session as { error?: string }).error === "RefreshTokenExpired") {
      signOut({ callbackUrl: "/auth/login" });
      return;
    }

    const expires = (session as { accessTokenExpires?: number }).accessTokenExpires;
    if (!expires) {
      setTimeUntilExpiry(null);
      return;
    }

    // Schedule a router refresh 30 s before the access token expires
    const msUntilRefresh = expires * 1000 - Date.now() - 30_000;
    if (msUntilRefresh <= 0) {
      setTimeUntilExpiry(0);
      return;
    }

    const timer = setTimeout(() => {
      refreshSession();
    }, msUntilRefresh);

    // Update timeUntilExpiry every second
    const updateTimer = setInterval(() => {
      const remaining = expires * 1000 - Date.now();
      setTimeUntilExpiry(Math.max(0, remaining));
    }, 1000);

    return () => {
      clearTimeout(timer);
      clearInterval(updateTimer);
    };
  }, [session, refreshSession]);

  return { timeUntilExpiry, refreshSession };
}
