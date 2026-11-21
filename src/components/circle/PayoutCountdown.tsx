"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import styles from "./PayoutCountdown.module.css";

interface Props {
  nextPayoutAt: Date | string;
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  isDue: boolean;
}

/** True when fewer than 60 seconds remain — triggers urgent announcement. */
function isUrgent(timeLeft: TimeLeft): boolean {
  return !timeLeft.isDue && timeLeft.totalSeconds <= 60;
}

/** Human-readable announcement string for screen readers. */
function buildAnnouncementText(timeLeft: TimeLeft): string {
  if (timeLeft.isDue) return "Payout is now due.";
  if (timeLeft.totalSeconds <= 60)
    return `Payout in ${timeLeft.totalSeconds} seconds.`;
  const parts: string[] = [];
  if (timeLeft.days > 0) parts.push(`${timeLeft.days} day${timeLeft.days !== 1 ? "s" : ""}`);
  if (timeLeft.hours > 0) parts.push(`${timeLeft.hours} hour${timeLeft.hours !== 1 ? "s" : ""}`);
  if (timeLeft.minutes > 0) parts.push(`${timeLeft.minutes} minute${timeLeft.minutes !== 1 ? "s" : ""}`);
  return `Next payout in ${parts.join(", ") || "less than a minute"}.`;
}

export function PayoutCountdown({ nextPayoutAt }: Props) {
  const calculateTimeLeft = useCallback((): TimeLeft => {
    const target = new Date(nextPayoutAt).getTime();
    const now = new Date().getTime();
    const difference = target - now;

    if (difference <= 0) {
      return { days: 0, hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, isDue: true };
    }

    const totalSeconds = Math.floor(difference / 1000);
    return {
      days: Math.floor(difference / (1000 * 60 * 60 * 24)),
      hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
      minutes: Math.floor((difference / 1000 / 60) % 60),
      seconds: Math.floor((difference / 1000) % 60),
      totalSeconds,
      isDue: false,
    };
  }, [nextPayoutAt]);

  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  // Tracks the last minute we announced so we announce at most once per minute.
  const lastAnnouncedMinuteRef = useRef<number>(-1);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      const updated = calculateTimeLeft();
      setTimeLeft(updated);

      if (updated.isDue) {
        clearInterval(timer);
        setAnnouncement(buildAnnouncementText(updated));
        return;
      }

      // Urgent: announce every second in the final 60 s.
      if (isUrgent(updated)) {
        setAnnouncement(buildAnnouncementText(updated));
        return;
      }

      // Normal: announce once per minute (when seconds roll over to 0).
      const currentMinute = Math.floor(updated.totalSeconds / 60);
      if (currentMinute !== lastAnnouncedMinuteRef.current) {
        lastAnnouncedMinuteRef.current = currentMinute;
        setAnnouncement(buildAnnouncementText(updated));
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [calculateTimeLeft]);

  // Don't render until client-side sync to avoid hydration mismatch.
  if (!timeLeft) {
    return (
      <div className={styles.container} aria-hidden="true">
        <span className={styles.label}>Calculating time...</span>
        <div className={styles.skeleton}></div>
      </div>
    );
  }

  const urgent = isUrgent(timeLeft);

  if (timeLeft.isDue) {
    return (
      <div
        className={styles.container}
        role="timer"
        aria-live="assertive"
        aria-atomic="true"
        aria-label="Payout is now due"
      >
        <span className={styles.label}>Next Payout</span>
        <div className={styles.due}>Payout due</div>
      </div>
    );
  }

  return (
    <div
      className={styles.container}
      role="timer"
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={buildAnnouncementText(timeLeft)}
    >
      <span className={styles.label}>Next Payout In</span>
      <div className={styles.timer}>
        <TimeUnit value={timeLeft.days} label="Days" />
        <TimeUnit value={timeLeft.hours} label="Hrs" />
        <TimeUnit value={timeLeft.minutes} label="Min" />
        <TimeUnit value={timeLeft.seconds} label="Sec" />
      </div>
      {/* Visually hidden live region carries announcements to screen readers. */}
      <span
        className={styles.srOnly}
        aria-live={urgent ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {announcement}
      </span>
    </div>
  );
}

function TimeUnit({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.unit} aria-hidden="true">
      <span className={styles.value}>{value.toString().padStart(2, "0")}</span>
      <span className={styles.unitLabel}>{label}</span>
    </div>
  );
}
