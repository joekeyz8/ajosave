import type { CircleFilters } from "@/types";

/**
 * Build a URL query string from a {@link CircleFilters} object.
 *
 * Only filters that are actually set are included, so an empty filter object
 * yields an empty string. The returned value is suitable for appending to the
 * circles API endpoint (e.g. `/api/v1/circles?status=open`).
 *
 * Kept as a pure, framework-agnostic helper so it can be reused by both
 * server-side code (page search-param parsing) and client-side data hooks.
 */
export function circleFiltersToQuery(filters: CircleFilters): string {
  const params = new URLSearchParams();

  if (filters.status) params.set("status", filters.status);
  if (filters.frequency) params.set("frequency", filters.frequency);
  if (filters.minAmount !== undefined) params.set("minAmount", String(filters.minAmount));
  if (filters.maxAmount !== undefined) params.set("maxAmount", String(filters.maxAmount));
  if (filters.maxMembers !== undefined) params.set("maxMembers", String(filters.maxMembers));
  if (filters.search) params.set("search", filters.search);

  return params.toString();
}

/**
 * Whether any filter is currently active (i.e. the list is being narrowed).
 *
 * Used to decide which empty-state illustration to show: a "no matches"
 * state when filters are active vs. a "nothing here yet" state when they are.
 */
export function hasActiveCircleFilters(filters: CircleFilters): boolean {
  return (
    !!filters.status ||
    !!filters.frequency ||
    !!filters.search ||
    filters.minAmount !== undefined ||
    filters.maxAmount !== undefined ||
    filters.maxMembers !== undefined
  );
}
