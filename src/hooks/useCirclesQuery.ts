"use client";

import { useEffect, useState, useCallback } from "react";
import { useQueryInvalidation } from "@/lib/queryInvalidation";
import { circleFiltersToQuery } from "@/lib/circleFilters";
import type { Circle, CircleFilters } from "@/types";

export const QUERY_KEYS = {
  circles: "circles",
  circle: (id: string) => `circles:${id}`,
  contributions: "contributions",
  contribution: (id: string) => `contributions:${id}`,
  dashboard: "dashboard",
} as const;

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

  // Serialise the active filters into a stable query string. Depending on the
  // string (rather than the object) avoids refetch churn when a parent passes
  // a fresh object literal with identical values on every render.
  const filterQuery = circleFiltersToQuery(filters ?? {});
  // Pull a generous page so the UI can paginate client-side without an extra
  // round-trip on every "next page" click.
  const query = filterQuery ? `${filterQuery}&limit=100` : "limit=100";

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetch(`/api/v1/circles?${query}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        setCircles(extractCircles(json));
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
