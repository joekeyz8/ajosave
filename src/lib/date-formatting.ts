import { formatDistanceToNow } from "date-fns";

/**
 * Format a date using the user's locale.
 * Falls back to en-US if locale is not supported by Intl.DateTimeFormat.
 */
export function formatDate(date: Date, locale: string, options?: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...options,
    }).format(date);
  } catch {
    // Fall back to en-US if locale is invalid
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...options,
    }).format(date);
  }
}

/**
 * Format a date as a relative time string (e.g., "3 days ago") using Intl.RelativeTimeFormat.
 * Falls back to en-US if locale is not supported.
 */
export function formatRelativeTime(date: Date, locale: string): string {
  try {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    // Determine the appropriate unit and value
    if (Math.abs(diffSec) < 60) {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.round(-diffSec),
        "second"
      );
    }

    const diffMin = Math.floor(diffSec / 60);
    if (Math.abs(diffMin) < 60) {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.round(-diffMin),
        "minute"
      );
    }

    const diffHours = Math.floor(diffMin / 60);
    if (Math.abs(diffHours) < 24) {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.round(-diffHours),
        "hour"
      );
    }

    const diffDays = Math.floor(diffHours / 24);
    if (Math.abs(diffDays) < 30) {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.round(-diffDays),
        "day"
      );
    }

    const diffMonths = Math.floor(diffDays / 30);
    if (Math.abs(diffMonths) < 12) {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.round(-diffMonths),
        "month"
      );
    }

    const diffYears = Math.floor(diffMonths / 12);
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      Math.round(-diffYears),
      "year"
    );
  } catch {
    // Fall back to en-US if locale is invalid
    return formatRelativeTime(date, "en-US");
  }
}
