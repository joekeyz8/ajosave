"use client";

import { useState, useEffect, useRef } from "react";
import { STALE_TIMES } from "@/lib/queryKeys";

interface ExchangeRate {
  rate: number | null;
  fetchedAt: string | null;
  loading: boolean;
  error: string | null;
}

// staleTime: 300 s (STALE_TIMES.FX_RATE — issue #403)
// FX rates from the external provider change at most every few minutes.
// Polling at 60 s was wasteful and could hit provider rate limits on mobile.
const REFRESH_INTERVAL_MS = STALE_TIMES.FX_RATE;

export function useExchangeRate(currency = "NGN"): ExchangeRate {
  const [rate, setRate] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchRate = async () => {
      try {
        const res = await fetch(`/api/fx/rate?currency=${currency}`);
        const json = await res.json();
        if (!cancelled && json.success) {
          setRate(json.data.rate);
          setFetchedAt(json.data.fetchedAt);
          setError(null);
        } else if (!cancelled) {
          setError(json.error ?? "Failed to fetch rate");
        }
      } catch {
        if (!cancelled) setError("Failed to fetch rate");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchRate();
    timerRef.current = setInterval(fetchRate, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [currency]);

  return { rate, fetchedAt, loading, error };
}
