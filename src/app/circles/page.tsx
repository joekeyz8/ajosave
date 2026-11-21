import type { Metadata } from "next";
import { Suspense } from "react";
import { CircleFiltersForm } from "@/components/circle/CircleFiltersForm";
import { CircleList, CircleListSkeleton } from "@/components/circle/CircleList";
import type { CircleFilters } from "@/types";
import Link from "next/link";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Browse Circles" };

interface CirclesPageProps {
  // Next.js 15+ exposes `searchParams` as a Promise; await it before reading.
  searchParams: Promise<{
    status?: string;
    frequency?: string;
    minAmount?: string;
    maxAmount?: string;
    maxMembers?: string;
    search?: string;
    page?: string;
    cursor?: string;
    filter?: string;
  }>;
}

/**
 * Circles listing page with filter support.
 *
 * Filters are read from URL search params so that filtered URLs are shareable
 * and reflected in the address bar. The filter form (client component) updates
 * the URL; this page re-renders on the server with the new params and passes
 * them down. The list itself is fetched client-side via `useCirclesQuery` so
 * that skeleton loading states can be shown while data is in flight.
 */
export default async function CirclesPage({ searchParams }: CirclesPageProps) {
  const sp = await searchParams;

  // Parse filter params from URL (all optional)
  const filters: CircleFilters = {
    status: (sp.status as CircleFilters["status"]) || undefined,
    frequency: (sp.frequency as CircleFilters["frequency"]) || undefined,
    minAmount: sp.minAmount ? parseInt(sp.minAmount, 10) : undefined,
    maxAmount: sp.maxAmount ? parseInt(sp.maxAmount, 10) : undefined,
    maxMembers: sp.maxMembers ? parseInt(sp.maxMembers, 10) : undefined,
    search: sp.search || undefined,
  };

  return (
    <div className={styles.page}>
      <div className="container">
        <div className={styles.header}>
          <h1 className={styles.title}>Open Circles</h1>
          <Link href="/circles/create" className="btn btn--accent">
            + New Circle
          </Link>
        </div>

        {/* Filter controls — wrapped in Suspense because it uses useSearchParams */}
        <Suspense fallback={null}>
          <CircleFiltersForm filters={filters} />
        </Suspense>

        {/* Circle list — fetched client-side with skeleton loading states */}
        <Suspense fallback={<CircleListSkeleton />}>
          <CircleList filters={filters} />
        </Suspense>
      </div>
    </div>
  );
}
