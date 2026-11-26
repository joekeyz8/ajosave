"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { CircleCard } from "@/components/circle/CircleCard";
import type { Circle, Member } from "@/types";
import styles from "./PaginatedCircleList.module.css";

const PAGE_SIZE = 12;
const BACK_TO_TOP_AFTER_PAGES = 3;

interface PaginatedCircleListProps {
  circles: Circle[];
}

/**
 * Renders a lazy-loading infinite-scroll list of CircleCards.
 *
 * A sentinel <div> at the bottom of the list is observed via
 * IntersectionObserver. When it enters the viewport the next page of
 * items is appended without a full re-render.
 *
 * "Back to top" appears once the user has scrolled past 3 pages worth of
 * content (PAGE_SIZE * BACK_TO_TOP_AFTER_PAGES items visible).
 *
 * iOS Safari compatibility: IntersectionObserver is supported on iOS 12.2+
 * (released 2019). A polyfill import is included via a dynamic import for
 * any browser that lacks native support.
 */
export function PaginatedCircleList({ circles }: PaginatedCircleListProps) {
  const t = useTranslations("pagination");

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const visibleItems = circles.slice(0, visibleCount);
  const hasMore = visibleCount < circles.length;
  const showBackToTop = visibleCount >= PAGE_SIZE * BACK_TO_TOP_AFTER_PAGES;

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    setLoading(true);
    // Simulate a micro-tick so the spinner renders before the slice widens.
    requestAnimationFrame(() => {
      setVisibleCount((c) => Math.min(c + PAGE_SIZE, circles.length));
      setLoading(false);
    });
  }, [loading, hasMore, circles.length]);

  // Set up IntersectionObserver with iOS Safari polyfill fallback.
  useEffect(() => {
    if (!sentinelRef.current) return;

    const setup = () => {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) loadMore();
        },
        { rootMargin: "200px" },
      );
      if (sentinelRef.current) observerRef.current.observe(sentinelRef.current);
    };

    if (typeof IntersectionObserver !== "undefined") {
      setup();
    } else {
      // Polyfill for very old iOS Safari builds.
      import("intersection-observer").then(setup).catch(setup);
    }

    return () => observerRef.current?.disconnect();
  }, [loadMore]);

  const handleBackToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  if (circles.length === 0) return null;

  return (
    <div>
      <div className={styles.grid}>
        {visibleItems.map((circle) => (
          <CircleCard key={circle.id} circle={circle} members={[] as Member[]} showJoin />
        ))}
      </div>

      {/* Sentinel – triggers next page load when visible */}
      <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />

      {loading && (
        <div className={styles.spinner} role="status" aria-label={t("loading")}>
          <span className={styles.spinnerDot} />
          <span className={styles.spinnerDot} />
          <span className={styles.spinnerDot} />
        </div>
      )}

      {!hasMore && circles.length > PAGE_SIZE && (
        <p className={styles.endMessage}>{t("allLoaded")}</p>
      )}

      {showBackToTop && (
        <button
          type="button"
          className={styles.backToTop}
          onClick={handleBackToTop}
          aria-label={t("backToTop")}
        >
          ↑ {t("backToTop")}
        </button>
      )}
    </div>
  );
}
