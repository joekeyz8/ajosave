"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/date-formatting";
import { useLocale } from "next-intl";
import styles from "./PayoutHistory.module.css";
import type { ContributionRow } from "@/server/services/contribution.service";

interface Props {
  circleId: string;
  initialData?: { data: ContributionRow[]; total: number };
}

const PAGE_SIZE = 20;

export function ContributionHistory({ circleId, initialData }: Props) {
  const locale = useLocale();
  const [rows, setRows] = useState<ContributionRow[] | null>(initialData?.data ?? null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(initialData?.total ?? null);
  const [error, setError] = useState<string | null>(null);

  // Track whether we've done the initial fetch when no initialData provided.
  const didInitialFetch = useRef(false);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);

      try {
        const res = await fetch(
          `/api/circles/${circleId}/contributions?${params}`
        );
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Failed to load");

        const { items, nextCursor: nc, hasMore: hm, total: t } = json.data as {
          items: ContributionRow[];
          nextCursor: string | null;
          hasMore: boolean;
          total: number;
        };

        setRows((prev) => (append ? [...prev, ...items] : items));
        setTotal(t ?? 0);
        setNextCursor(nc);
        setHasMore(hm);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load contributions");
      }
    },
    [circleId]
  );

  // Initial fetch — only runs when no server-side initialData was supplied.
  useEffect(() => {
    if (initialData || didInitialFetch.current) return;
    didInitialFetch.current = true;

    setLoading(true);
    fetchPage(null, false).finally(() => setLoading(false));
  }, [initialData, fetchPage]);

  const handleLoadMore = async () => {
    if (!hasMore || loadingMore || !nextCursor) return;
    setLoadingMore(true);
    await fetchPage(nextCursor, true);
    setLoadingMore(false);
  };

  if (loading) {
    return (
      <div className={styles.skeletonWrap}>
        {[1, 2, 3].map((i) => (
          <div key={i} className={`${styles.skeletonRow} skeleton`} />
        ))}
      </div>
    );
  }

  if (error) return <p className={styles.error}>{error}</p>;

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon} aria-hidden>
          🧾
        </span>
        <p>No contributions yet.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Total record count */}
      <p
        className={styles.totalCount}
        aria-live="polite"
        aria-atomic="true"
      >
        {total} contribution{total !== 1 ? "s" : ""} total
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Member</th>
              <th>Amount (USDC)</th>
              <th>Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.cycleNumber}</td>
                <td>{r.memberName}</td>
                <td>{parseFloat(r.amountUsdc).toFixed(2)}</td>
                <td>{formatDate(new Date(r.createdAt), locale)}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div style={{ marginTop: "12px", textAlign: "center" }}>
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="btn btn--ghost"
            aria-busy={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
