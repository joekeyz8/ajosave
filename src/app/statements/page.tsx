"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import type { ActivityStatement } from "@/server/services/activity-statement.service";
import styles from "./page.module.css";

export default function ActivityStatementsPage() {
  const { status } = useSession();
  const router = useRouter();
  const [statement, setStatement] = useState<ActivityStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const printRef = useRef<HTMLDivElement>(null);
  const [userName, setUserName] = useState<string>("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/auth/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    // Fetch user profile to get name
    fetch("/api/v1/profile")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setUserName(json.data.displayName || json.data.phone || "User");
      });

    // Load activity statement
    fetchStatement();
  }, [status]);

  const fetchStatement = async (from?: string, to?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.append("from", from);
      if (to) params.append("to", to);

      const res = await fetch(`/api/v1/users/me/activity-statement?${params.toString()}`);
      const json = await res.json();

      if (!json.success) throw new Error(json.error);
      setStatement(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load statement");
    } finally {
      setLoading(false);
    }
  };

  const handleDateFilter = () => {
    fetchStatement(fromDate || undefined, toDate || undefined);
  };

  const handlePrint = () => {
    window.print();
  };

  if (status === "loading" || !statement) {
    return (
      <div className="container" style={{ padding: "var(--space-6)" }}>
        <div style={{ textAlign: "center" }}>
          {loading ? <p>Loading your activity statement...</p> : <p>No data</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className="container">
        <div className={styles.header}>
          <h1 className={styles.title}>Activity Statement</h1>
          <div className={styles.actions}>
            <button onClick={handlePrint} className="btn btn--primary" aria-label="Download PDF or print activity statement">
              📥 Download PDF
            </button>
          </div>
        </div>

        {error && (
          <div style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid var(--color-error)", borderRadius: "var(--radius-md)", padding: "var(--space-4)", marginBottom: "var(--space-6)", color: "var(--color-error)" }}>
            {error}
          </div>
        )}

        <div className={styles.filterSection}>
          <div className={styles.filterGroup}>
            <label className="input-label" htmlFor="from-date">From</label>
            <input
              id="from-date"
              type="date"
              className="input"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className={styles.filterGroup}>
            <label className="input-label" htmlFor="to-date">To</label>
            <input
              id="to-date"
              type="date"
              className="input"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          <button onClick={handleDateFilter} className="btn btn--secondary" style={{ alignSelf: "flex-end" }}>
            Filter
          </button>
        </div>

        <div ref={printRef} className={styles.printContent}>
          {/* Print Header */}
          <div className={styles.printHeader}>
            <div className={styles.logoArea}>
              <h2 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>Ajosave</h2>
              <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", margin: "0.25rem 0 0 0" }}>Activity Statement</p>
            </div>
            <div style={{ textAlign: "right", fontSize: "0.875rem" }}>
              <p style={{ margin: 0 }}><strong>Generated:</strong> {format(new Date(statement.generatedAt), "MMM dd, yyyy")}</p>
              <p style={{ margin: "0.25rem 0 0 0" }}><strong>User:</strong> {userName}</p>
            </div>
          </div>

          {/* Summary Section */}
          <div className={styles.summarySection}>
            <h3 style={{ marginTop: 0 }}>Statement Summary</h3>
            <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", marginBottom: "var(--space-4)" }}>
              {format(new Date(statement.periodStart), "MMM dd, yyyy")} – {format(new Date(statement.periodEnd), "MMM dd, yyyy")}
            </p>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Total Contributed</span>
                <span className={styles.summaryValue}>{statement.totalContributedUsdc} USDC</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Total Received</span>
                <span className={styles.summaryValue}>{statement.totalReceivedUsdc} USDC</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Circles Participated</span>
                <span className={styles.summaryValue}>{statement.circleCount}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Transactions</span>
                <span className={styles.summaryValue}>{statement.entries.length}</span>
              </div>
            </div>
          </div>

          {/* Transactions Table */}
          <div className={styles.tableSection}>
            <h3 style={{ marginTop: 0 }}>Transaction Details</h3>
            {statement.entries.length === 0 ? (
              <p style={{ color: "var(--color-text-muted)" }}>No transactions in this period.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Circle</th>
                    <th>Cycle</th>
                    <th className={styles.amountCol}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.entries.map((entry, idx) => (
                    <tr key={idx}>
                      <td>{format(new Date(entry.occurredAt), "MMM dd, yyyy")}</td>
                      <td>
                        <span className={`${styles.badge} ${styles[`badge-${entry.type}`]}`}>
                          {entry.type === "contribution" ? "Contribution" : "Payout"}
                        </span>
                      </td>
                      <td>{entry.circleName}</td>
                      <td>{entry.cycleNumber}</td>
                      <td className={styles.amountCol}>
                        {entry.amountUsdc ? `${entry.amountUsdc} USDC` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer */}
          <div className={styles.printFooter}>
            <p style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", margin: 0 }}>
              This statement is generated for record-keeping and tax purposes. For account verification, please log into your Ajosave account.
            </p>
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          body {
            margin: 0;
            padding: 0;
            background: white;
          }
          .${styles.page} {
            padding: 0;
          }
          .container {
            max-width: 100%;
            margin: 0;
            padding: 0;
          }
          .${styles.header},
          .${styles.filterSection},
          .${styles.actions} {
            display: none !important;
          }
          .${styles.printContent} {
            padding: 20mm;
            break-inside: avoid;
          }
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th, td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
          }
          th {
            background: #f5f5f5;
            font-weight: 600;
          }
          .${styles.printHeader} {
            display: flex;
            justify-content: space-between;
            margin-bottom: 20mm;
            border-bottom: 2px solid #333;
            padding-bottom: 10mm;
          }
        }
      `}</style>
    </div>
  );
}
