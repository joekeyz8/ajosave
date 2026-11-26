"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useQueryInvalidation } from "@/lib/queryInvalidation";
import { QUERY_KEYS, STALE_TIMES } from "@/lib/queryKeys";
import type { Circle } from "@/types";

// Re-export so existing imports from this file continue to work (issue #402).
export { QUERY_KEYS } from "@/lib/queryKeys";

interface UseCirclesQueryResult {
  circles: Circle[];
  isLoading: boolean;
  error: string | null;
  /** Manually trigger a refresh without needing an invalidation event. */
  refresh: () => void;
}

/**
 * Fetches the open circles list and automatically refetches whenever
 * the "circles" query key is invalidated via useQueryInvalidation.
 *
 * staleTime: 60 s (STALE_TIMES.CIRCLE_LIST — issue #403)
 * The list changes infrequently; we skip background refetches that arrive
 * within the stale window to reduce unnecessary API load on mobile.
 * An explicit invalidateQuery("circles") always bypasses the stale check.
 *
 * Any component can trigger a shared refetch across all consumers by calling:
 *   const { invalidateQuery } = useQueryInvalidation();
 *   invalidateQuery("circles");
 *
 * @param filters Optional discovery filters. When provided, the query string
 *                is derived from them and the hook refetches whenever the
 *                *serialised* filter set changes (so passing a new object with
 *                the same values does not cause a redundant request).
 */
export function useCirclesQuery(filters?: CircleFilters): UseCirclesQueryResult {
  const { getQueryVersion, invalidateQuery: _invalidateQuery } = useQueryInvalidation();

  // Track the invalidation version as a refetch trigger.
  const version = getQueryVersion(QUERY_KEYS.circles);

  const [circles, setCircles] = useState<Circle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track when we last successfully fetched so we can honour the stale window.
  const lastFetchedAtRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    // staleTime: 60 s — skip background refetch if data is still fresh.
    // A version bump (explicit invalidation) always forces a refetch regardless.
    const age = Date.now() - lastFetchedAtRef.current;
    if (age < STALE_TIMES.CIRCLE_LIST && lastFetchedAtRef.current > 0) {
      return;
    }

    setIsLoading(true);
    setError(null);

    fetch(`/api/v1/circles?${query}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        const data: Circle[] = json?.data ?? json ?? [];
        setCircles(Array.isArray(data) ? data : []);
        lastFetchedAtRef.current = Date.now();
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load circles");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `version` changes whenever invalidateQuery("circles") is called;
    // `query` changes when the active filters change. Either triggers a refetch.
  }, [version, query]);

  const refresh = useCallback(() => {
    // Force refetch by resetting the stale timestamp before invalidating.
    lastFetchedAtRef.current = 0;
    _invalidateQuery(QUERY_KEYS.circles);
  }, [_invalidateQuery]);

  return { circles, isLoading, error, refresh };
}

/**
 * Normalise the various response shapes the circles endpoint can return:
 *   - Cursor pagination (default):  { data: { items: Circle[], … } }
 *   - Legacy offset pagination:     { data: { data: Circle[], … } }
 *   - Plain array (e.g. filter=mine): { data: Circle[] }
 */
function extractCircles(json: unknown): Circle[] {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as Circle[];
  if (data && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: Circle[] }).items;
  }
  if (data && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: Circle[] }).data;
  }
  return [];
}
