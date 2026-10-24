"use client";

import { useEffect, useState } from "react";
import styles from "./PWAInstallBanner.module.css";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "ajosave:pwa-banner-dismissed-until";
const DISMISS_DAYS = 30;

/** Returns true when the app is running in standalone (installed) mode. */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Returns true when the banner was dismissed within the last 30 days. */
function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() < Number(raw);
  } catch {
    return false;
  }
}

export function PWAInstallBanner() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if already installed or recently dismissed.
    if (isStandalone() || isDismissed()) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      setVisible(false);
      setPrompt(null);
    }
  };

  const handleDismiss = () => {
    try {
      const until = Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000;
      localStorage.setItem(DISMISS_KEY, String(until));
    } catch {
      // Storage unavailable — ignore.
    }
    setVisible(false);
    setPrompt(null);
  };

  if (!visible) return null;

  return (
    <div
      className={styles.banner}
      role="banner"
      aria-label="Install Ajosave app"
    >
      <span className={styles.icon} aria-hidden="true">📲</span>

      <div className={styles.text}>
        <strong className={styles.heading}>Add to home screen</strong>
        <span className={styles.sub}>Get the full app experience — offline access & faster loads.</span>
      </div>

      <div className={styles.actions}>
        <button
          className="btn btn--primary btn--sm"
          onClick={handleInstall}
          aria-label="Install Ajosave app"
        >
          Install
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={handleDismiss}
          aria-label="Dismiss install prompt"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
