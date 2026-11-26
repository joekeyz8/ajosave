"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { useSessionRefresh } from "@/hooks/useSessionRefresh";

/**
 * SessionExpiryWarning
 *
 * Shows a modal warning 5 minutes before the session expires.
 * Monitors for user inactivity and doesn't show the modal if idle for 10+ minutes.
 * Offers "Stay logged in" and "Log out" options.
 */
export function SessionExpiryWarning(): JSX.Element | null {
  const router = useRouter();
  const { timeUntilExpiry, refreshSession } = useSessionRefresh();
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());
  const modalShownRef = useRef(false);

  // Track user activity
  useEffect(() => {
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };

    document.addEventListener("mousedown", updateActivity);
    document.addEventListener("keydown", updateActivity);
    document.addEventListener("touchstart", updateActivity);
    document.addEventListener("click", updateActivity);

    return () => {
      document.removeEventListener("mousedown", updateActivity);
      document.removeEventListener("keydown", updateActivity);
      document.removeEventListener("touchstart", updateActivity);
      document.removeEventListener("click", updateActivity);
    };
  }, []);

  // Check if session is expiring and user is active
  useEffect(() => {
    if (timeUntilExpiry === null || timeUntilExpiry === undefined) {
      return;
    }

    // 5 minutes = 300,000 ms
    const FIVE_MINUTES = 5 * 60 * 1000;
    // 10 minutes = 600,000 ms
    const TEN_MINUTES = 10 * 60 * 1000;
    const timeSinceLastActivity = Date.now() - lastActivityRef.current;

    // Show modal if:
    // 1. Session is expiring in 5 minutes or less
    // 2. User is not idle (has activity within last 10 minutes)
    // 3. Modal hasn't been shown yet for this session expiry event
    if (
      timeUntilExpiry <= FIVE_MINUTES &&
      timeUntilExpiry > 0 &&
      timeSinceLastActivity < TEN_MINUTES &&
      !modalShownRef.current
    ) {
      setShowModal(true);
      modalShownRef.current = true;
    }

    // If session expired and user is on a page that requires auth, redirect
    if (timeUntilExpiry <= 0 && showModal) {
      setShowModal(false);
      signOut({ callbackUrl: "/auth/login?expired=true" });
    }
  }, [timeUntilExpiry, showModal]);

  const handleStayLoggedIn = async () => {
    setLoading(true);
    try {
      await refreshSession();
      setShowModal(false);
      modalShownRef.current = false;
      setLoading(false);
    } catch (err) {
      console.error("Failed to refresh session:", err);
      setLoading(false);
    }
  };

  const handleLogOut = async () => {
    setLoading(true);
    await signOut({ callbackUrl: "/auth/login" });
  };

  return (
    <ConfirmModal
      open={showModal}
      title="Session Expiring Soon"
      message="Your session will expire in 5 minutes. Would you like to stay logged in?"
      confirmLabel="Stay logged in"
      cancelLabel="Log out"
      loading={loading}
      onConfirm={handleStayLoggedIn}
      onCancel={handleLogOut}
    />
  );
}
