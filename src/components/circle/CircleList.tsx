"use client";

import { useCirclesQuery } from "@/hooks/useCirclesQuery";
import { usePagination } from "@/hooks/usePagination";
import { hasActiveCircleFilters } from "@/lib/circleFilters";
import { CircleCard } from "@/components/circle/CircleCard";
import { CircleCardSkeleton } from "@/components/circle/CircleCardSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import type { CircleFilters, Member } from "@/types";
import styles from "./CircleList.module.css";

/**
 * Default number of circles shown per page. The skeleton count while loading
 * matches this value so the loaded cards occupy the same grid cells as the
 * skeletons (no cumulative layout shift).
 */
export const CIRCLE_PAGE_SIZE = 10;

interface CircleListProps {
  /** Active discovery filters (read from URL by the parent page). */
  filters: CircleFilters;
}

/**
 * Client-rendered grid of open circles.
 *
 * Uses {@link useCirclesQuery} so a loading state is observable: while the
 * first fetch is in flight we render {@link CIRCLE_PAGE_SIZE} skeleton cards,
 * then swap in real cards once data arrives. Because skeletons and cards
 * share the exact same grid, the swap produces no layout shift or flicker.
 */
export function CircleList({ filters }: CircleListProps) {
  const { circles, isLoading, error, refresh } = useCirclesQuery(filters);
  const {
    items,
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage,
    hasPrevPage,
    nextPage,
    prevPage,
    goToPage,
  } = usePagination(circles, CIRCLE_PAGE_SIZE);

  // ── Loading: render page-size skeletons immediately on mount/refetch ────────
  if (isLoading) {
    return <CircleListSkeleton count={CIRCLE_PAGE_SIZE} />;
  }

  // ── Error: offer a retry without losing the page chrome ─────────────────────
  if (error) {
    return (
      <div className={styles.error} role="alert">
        <p className={styles.errorText}>We couldn&apos;t load circles right now.</p>
        <button type="button" className="btn btn--secondary btn--sm" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  }

  // ── Empty: meaningful state with illustration + CTAs ───────────────────────
  if (circles.length === 0) {
    if (hasActiveCircleFilters(filters)) {
      return (
        <EmptyState
          illustration="search"
          title="No circles match your filters"
          description="Try widening your search or clear the filters to see all open circles."
          ctas={[{ label: "Browse Circles", href: "/circles", variant: "primary" }]}
        />
      );
    }

    return (
      <EmptyState
        illustration="circles"
        title="No open circles yet"
        description="Be the first to start a savings circle, or browse what others have created."
        ctas={[
          { label: "Create a Circle", href: "/circles/create", variant: "primary" },
          { label: "Browse Circles", href: "/circles", variant: "secondary" },
        ]}
      />
    );
  }

  // ── Data: paginated grid of real cards ──────────────────────────────────────
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  const label = `Showing ${start}–${end} of ${totalItems} circle${totalItems !== 1 ? "s" : ""}`;

  return (
    <div>
      <div className={styles.grid}>
        {items.map((circle) => (
          <CircleCard key={circle.id} circle={circle} members={[] as Member[]} showJoin />
        ))}
      </div>

      <Pagination
        page={page}
        totalPages={totalPages}
        hasNextPage={hasNextPage}
        hasPrevPage={hasPrevPage}
        onNext={nextPage}
        onPrev={prevPage}
        onGoToPage={goToPage}
        label={label}
      />
    </div>
  );
}

/**
 * Loading placeholder for {@link CircleList}. Renders `count` skeleton cards in
 * the same grid used by the real list, plus an `aria-busy` / sr-only status so
 * assistive tech announces the loading state.
 */
export function CircleListSkeleton({ count = CIRCLE_PAGE_SIZE }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading circles">
      <span className="sr-only" role="status">
        Loading circles…
      </span>
      <div className={styles.grid}>
        {Array.from({ length: count }).map((_, i) => (
          <CircleCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
