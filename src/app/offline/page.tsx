"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import styles from "./offline.module.css";

export default function OfflinePage() {
  const t = useTranslations("offline");
  const [isBack, setIsBack] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsBack(true);
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const handleRetry = () => window.location.reload();

  return (
    <div className={styles.wrapper}>
      {/* Branded logo */}
      <Image
        src="/icons/icon-192.svg"
        alt="Ajosave"
        width={72}
        height={72}
        className={styles.logo}
        priority
      />

      {isBack ? (
        <>
          <h1 className={styles.heading}>You&apos;re back online!</h1>
          <p className={styles.message}>
            Connection restored. Head back to pick up where you left off.
          </p>
          <a href="/" className="btn btn--primary">
            Go to home
          </a>
        </>
      ) : (
        <>
          <h1 className={styles.heading}>{t("heading")}</h1>
          <p className={styles.message}>{t("message")}</p>

          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleRetry}
            >
              {t("retry")}
            </button>
            <a href="/circles" className="btn btn--secondary">
              My Circles
            </a>
            <a href="/dashboard" className="btn btn--secondary">
              Dashboard
            </a>
          </div>

          <p className={styles.waiting} aria-live="polite">
            Waiting for connection to restore…
          </p>
        </>
      )}
    </div>
  );
}
