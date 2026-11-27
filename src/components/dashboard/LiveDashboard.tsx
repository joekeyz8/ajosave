"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import type { Circle } from "@/types";
import { CircleCard } from "@/components/circle/CircleCard";
import { ConnectionStatus } from "@/components/ui/ConnectionStatus";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePolling } from "@/hooks/usePolling";
import Link from "next/link";
import styles from "./LiveDashboard.module.css";

function ExportCSVButton() {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const res = await fetch("/api/user/contributions/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contributions-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={handleExport} disabled={loading} className="btn btn--secondary btn--sm">
      {loading ? "Exporting…" : "Export CSV"}
    </button>
  );
}

interface LiveDashboardProps {
  initialCircles: Circle[];
}

export function LiveDashboard({ initialCircles }: LiveDashboardProps) {
  const [circles, setCircles] = useState<Circle[]>(initialCircles);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [newCirclesCount, setNewCirclesCount] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Track whether the component has completed its first client-side render.
  // ConnectionStatus depends on `isConnected` (from usePolling) and `lastUpdate`,
  // both of which are always undefined/false on the server but change immediately
  // on the client once polling fires. Rendering ConnectionStatus only after mount
  // prevents the server HTML snapshot from diverging from the first client paint
  // and eliminates React hydration mismatch errors (#394).
  const [isMounted, setIsMounted] = useState(false);
  const circlesRef = useRef(circles);

  const fetchCircles = useCallback(async () => {
    const res = await fetch("/api/circles?filter=mine");
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data as Circle[];
  }, []);

  // Keep ref in sync so the onSuccess closure always reads the current length
  // without needing `circles` in its dependency array (which would re-create the
  // polling interval on every data update).
  circlesRef.current = circles;

  const { isConnected } = usePolling({
    fetchFn: fetchCircles,
    interval: 10000, // Poll every 10 seconds for user dashboard
    enabled: true,
    onSuccess: (data) => {
      const prevCount = circlesRef.current.length;
      const newCount = data.length;
      if (prevCount > 0 && newCount > prevCount) {
        setNewCirclesCount(newCount - prevCount);
        setTimeout(() => setNewCirclesCount(0), 3000);
      }
      setCircles(data);
      setLastUpdate(new Date());
    },
  });

  // Signal that the component has completed its first client-side render.
  // This gates ConnectionStatus so it is never part of the server HTML snapshot,
  // preventing hydration mismatches caused by isConnected/lastUpdate divergence.
  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("ajosave:onboarding");
      const parsed = stored ? JSON.parse(stored) : null;
      if (!parsed?.seen) setShowOnboarding(true);
    } catch {}
  }, []);

  return (
    <>
      <div className={styles.header}>
        <h1 className={styles.title}>My Circles</h1>
        <div className={styles.headerActions}>
          {/* Deferred until after hydration: isConnected and lastUpdate are
              always false/null on the server but change immediately on the
              client once usePolling fires, causing a hydration mismatch (#394).
              Rendering null on first paint matches the server snapshot exactly. */}
          {isMounted && (
            <ConnectionStatus isConnected={isConnected} lastUpdate={lastUpdate || undefined} />
          )}
          <ExportCSVButton />
          <Link href="/circles/create" className="btn btn--accent">
            + New Circle
          </Link>
        </div>
      </div>

      {newCirclesCount > 0 && (
        <div className={styles.newItemsBanner} role="status" aria-live="polite">
          🎉 {newCirclesCount} new circle{newCirclesCount !== 1 ? "s" : ""} available!
        </div>
      )}

      {circles.length === 0 ? (
        <EmptyState
          illustration="circles"
          title="Start your savings journey"
          description="You haven't joined any circles yet. Create your own or browse open circles to get started."
          ctas={[
            { label: "Create your first circle", href: "/circles/create", variant: "primary" },
            { label: "Browse circles", href: "/circles", variant: "secondary" },
          ]}
        />
      ) : (
        <div className={styles.grid}>
          {circles.map((circle) => (
            <CircleCard key={circle.id} circle={circle} members={[]} />
          ))}
        </div>
      )}

      {showOnboarding && (
        // Lazy-load to keep bundle small
        //@ts-ignore
        <Onboarding onClose={() => setShowOnboarding(false)} />
      )}
    </>
  );
}
