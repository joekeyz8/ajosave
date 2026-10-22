"use client";

import { useState, useEffect, useCallback, useId } from "react";
import type { AdminCircleRow } from "@/server/services/admin.service";
import { CircleStatusBadge } from "@/components/ui/CircleStatusBadge";
import { Button } from "@/components/ui/Button";
import { CopyableText } from "@/components/ui/CopyableText";
import { format } from "date-fns";
import { getCurrencySymbol, SupportedCurrency } from "@/lib/currency";
import { useKeyboardTableNav } from "@/hooks/useKeyboardTableNav";
import styles from "./admin.module.css";
import tableStyles from "./CirclesTable.module.css";

type SortKey = "name" | "status" | "memberCount" | "currentCycle" | "nextPayoutAt";
type SortDir = "asc" | "desc";
type BulkAction = "pause" | "cancel";
type RowAction = "pause" | "resume" | "cancel" | "payout";

interface CirclesTableProps {
  circles: AdminCircleRow[];
}

interface ConfirmDialog {
  action: RowAction | BulkAction;
  circleIds: string[];
  circleNames: string[];
}

function sortCircles(
  circles: AdminCircleRow[],
  key: SortKey,
  dir: SortDir
): AdminCircleRow[] {
  return [...circles].sort((a, b) => {
    let valA: string | number | null;
    let valB: string | number | null;

    switch (key) {
      case "name":
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
        break;
      case "status":
        valA = a.status;
        valB = b.status;
        break;
      case "memberCount":
        valA = a.memberCount;
        valB = b.memberCount;
        break;
      case "currentCycle":
        valA = a.currentCycle;
        valB = b.currentCycle;
        break;
      case "nextPayoutAt":
        valA = a.nextPayoutAt ? new Date(a.nextPayoutAt).getTime() : 0;
        valB = b.nextPayoutAt ? new Date(b.nextPayoutAt).getTime() : 0;
        break;
      default:
        return 0;
    }

    if (valA === valB) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;
    const cmp = valA < valB ? -1 : 1;
    return dir === "asc" ? cmp : -cmp;
  });
}

export function CirclesTable({ circles }: CirclesTableProps) {
  const tableRef = useKeyboardTableNav<HTMLTableElement>();
  const dialogId = useId();

  // State
  const [localCircles, setLocalCircles] = useState<AdminCircleRow[]>(circles);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmDialog | null>(null);
  const [actionInFlight, setActionInFlight] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Sync prop changes
  useEffect(() => setLocalCircles(circles), [circles]);

  // Derived: filtered + sorted list
  const displayed = sortCircles(
    localCircles.filter((c) => {
      const matchText =
        !filterText ||
        c.name.toLowerCase().includes(filterText.toLowerCase()) ||
        c.id.toLowerCase().includes(filterText.toLowerCase());
      const matchStatus =
        filterStatus === "all" || c.status === filterStatus;
      return matchText && matchStatus;
    }),
    sortKey,
    sortDir
  );

  // Selection helpers
  const allDisplayedIds = displayed.map((c) => c.id);
  const allSelected =
    allDisplayedIds.length > 0 &&
    allDisplayedIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allDisplayedIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allDisplayedIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [allSelected, allDisplayedIds]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Sorting
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return " ↕";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  // Currency helper
  const getCurrencySymbolForRow = (currency: string) =>
    getCurrencySymbol(currency as SupportedCurrency);

  // Show confirmation dialog
  const requestConfirm = (
    action: RowAction | BulkAction,
    ids: string[],
    names: string[]
  ) => {
    setConfirm({ action, circleIds: ids, circleNames: names });
  };

  // Execute confirmed action
  const executeAction = async () => {
    if (!confirm) return;
    const { action, circleIds } = confirm;
    setConfirm(null);

    const newInFlight = new Set(actionInFlight);
    circleIds.forEach((id) => newInFlight.add(id));
    setActionInFlight(newInFlight);
    setErrors([]);

    const results = await Promise.allSettled(
      circleIds.map(async (id) => {
        if (action === "payout") {
          const res = await fetch(`/api/admin/circles/${id}/payout`, {
            method: "POST",
          });
          const json = await res.json();
          if (!json.success) throw new Error(json.error ?? "Payout failed");
          return { id, result: json.data };
        } else {
          // pause / resume / cancel all go through /manage
          const apiAction = action === "cancel" ? "close" : action;
          const res = await fetch(`/api/admin/circles/${id}/manage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: apiAction }),
          });
          const json = await res.json();
          if (!json.success) throw new Error(json.error ?? "Action failed");
          return { id, result: json.data };
        }
      })
    );

    const newErrors: string[] = [];
    const updatedCircles = [...localCircles];

    results.forEach((result, i) => {
      const id = circleIds[i];
      if (result.status === "fulfilled") {
        const data = result.value.result;
        if (data?.status) {
          const idx = updatedCircles.findIndex((c) => c.id === id);
          if (idx !== -1) {
            updatedCircles[idx] = { ...updatedCircles[idx], status: data.status };
          }
        }
      } else {
        newErrors.push(
          `Circle ${id}: ${result.reason instanceof Error ? result.reason.message : "Unknown error"}`
        );
      }
    });

    setLocalCircles(updatedCircles);
    setActionInFlight((prev) => {
      const next = new Set(prev);
      circleIds.forEach((id) => next.delete(id));
      return next;
    });

    if (newErrors.length > 0) {
      setErrors(newErrors);
    } else {
      const label =
        action === "payout"
          ? "Payout triggered"
          : action === "pause"
          ? "Paused"
          : action === "resume"
          ? "Resumed"
          : "Cancelled";
      setSuccessMsg(
        `${label} successfully for ${circleIds.length} circle${circleIds.length !== 1 ? "s" : ""}.`
      );
      setTimeout(() => setSuccessMsg(null), 5000);
    }

    // Clear selection for bulk actions
    if (circleIds.length > 1) {
      setSelectedIds(new Set());
    }
  };

  if (circles.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No circles found.</p>
      </div>
    );
  }

  const selectedInDisplay = displayed.filter((c) => selectedIds.has(c.id));

  return (
    <>
      {/* Confirmation dialog */}
      {confirm && (
        <div
          className={tableStyles.dialogBackdrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${dialogId}-title`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirm(null);
          }}
        >
          <div className={tableStyles.dialog}>
            <h2 id={`${dialogId}-title`} className={tableStyles.dialogTitle}>
              Confirm:{" "}
              {confirm.action === "payout"
                ? "Force Payout"
                : confirm.action.charAt(0).toUpperCase() +
                  confirm.action.slice(1)}
            </h2>
            <p className={tableStyles.dialogBody}>
              {confirm.circleIds.length === 1 ? (
                <>
                  Are you sure you want to{" "}
                  <strong>
                    {confirm.action === "payout"
                      ? "force a payout for"
                      : confirm.action}
                  </strong>{" "}
                  circle <strong>&ldquo;{confirm.circleNames[0]}&rdquo;</strong>?
                  This action cannot be undone.
                </>
              ) : (
                <>
                  Are you sure you want to{" "}
                  <strong>
                    {confirm.action === "payout"
                      ? "force payouts for"
                      : `${confirm.action} all`}
                  </strong>{" "}
                  <strong>{confirm.circleIds.length} selected circles</strong>?
                  This action cannot be undone.
                </>
              )}
            </p>
            <div className={tableStyles.dialogActions}>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={
                  confirm.action === "cancel" || confirm.action === "payout"
                    ? "accent"
                    : "primary"
                }
                onClick={executeAction}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback messages */}
      {errors.map((err, i) => (
        <div key={i} className={styles.error} role="alert">
          {err}
        </div>
      ))}
      {successMsg && (
        <div className={tableStyles.success} role="status" aria-live="polite">
          {successMsg}
        </div>
      )}

      {/* Toolbar: filter + bulk actions */}
      <div className={tableStyles.toolbar}>
        <div className={tableStyles.filters}>
          <input
            type="search"
            placeholder="Search by name or ID…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className={tableStyles.searchInput}
            aria-label="Search circles"
          />
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className={tableStyles.statusFilter}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {someSelected && (
          <div className={tableStyles.bulkActions} role="toolbar" aria-label="Bulk actions">
            <span className={tableStyles.selectionCount}>
              {selectedIds.size} selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const names = selectedInDisplay.map((c) => c.name);
                const ids = selectedInDisplay.map((c) => c.id);
                requestConfirm("pause", ids, names);
              }}
              disabled={actionInFlight.size > 0}
            >
              Pause all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const names = selectedInDisplay.map((c) => c.name);
                const ids = selectedInDisplay.map((c) => c.id);
                requestConfirm("cancel", ids, names);
              }}
              disabled={actionInFlight.size > 0}
            >
              Cancel all
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className={styles.tableContainer}>
        <table
          ref={tableRef}
          className={styles.table}
          role="grid"
          aria-label="Circles management table"
        >
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate =
                        someSelected && !allSelected;
                    }
                  }}
                  onChange={toggleAll}
                  aria-label="Select all circles"
                />
              </th>
              <th
                scope="col"
                className={tableStyles.sortable}
                onClick={() => handleSort("name")}
                aria-sort={
                  sortKey === "name"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                Circle Name{sortIndicator("name")}
              </th>
              <th
                scope="col"
                className={tableStyles.sortable}
                onClick={() => handleSort("status")}
                aria-sort={
                  sortKey === "status"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                Status{sortIndicator("status")}
              </th>
              <th
                scope="col"
                className={tableStyles.sortable}
                onClick={() => handleSort("memberCount")}
                aria-sort={
                  sortKey === "memberCount"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                Members{sortIndicator("memberCount")}
              </th>
              <th scope="col">Contribution</th>
              <th
                scope="col"
                className={tableStyles.sortable}
                onClick={() => handleSort("currentCycle")}
                aria-sort={
                  sortKey === "currentCycle"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                Cycle{sortIndicator("currentCycle")}
              </th>
              <th
                scope="col"
                className={tableStyles.sortable}
                onClick={() => handleSort("nextPayoutAt")}
                aria-sort={
                  sortKey === "nextPayoutAt"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                Next Payout{sortIndicator("nextPayoutAt")}
              </th>
              <th scope="col">ID</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "var(--color-text-secondary)" }}>
                  No circles match the current filters.
                </td>
              </tr>
            ) : (
              displayed.map((circle) => {
                const isInFlight = actionInFlight.has(circle.id);
                const isSelected = selectedIds.has(circle.id);
                return (
                  <tr
                    key={circle.id}
                    className={isSelected ? tableStyles.selectedRow : undefined}
                    aria-selected={isSelected}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(circle.id)}
                        aria-label={`Select ${circle.name}`}
                        disabled={isInFlight}
                      />
                    </td>
                    <td>{circle.name}</td>
                    <td className={styles.statusCell}>
                      <CircleStatusBadge status={circle.status} />
                    </td>
                    <td>
                      {circle.memberCount} / {circle.maxMembers}
                    </td>
                    <td>
                      {getCurrencySymbolForRow(circle.contributionCurrency)}
                      {circle.contributionFiat.toLocaleString()}
                    </td>
                    <td>
                      {circle.currentCycle > 0 ? `#${circle.currentCycle}` : "—"}
                    </td>
                    <td>
                      {circle.nextPayoutAt
                        ? format(
                            new Date(circle.nextPayoutAt),
                            "MMM d, yyyy HH:mm"
                          )
                        : "—"}
                    </td>
                    <td>
                      <CopyableText
                        text={circle.id}
                        displayText={`${circle.id.slice(0, 8)}…`}
                        label="Copy circle ID"
                      />
                    </td>
                    <td className={styles.actionCell}>
                      {circle.status === "active" && (
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() =>
                            requestConfirm(
                              "payout",
                              [circle.id],
                              [circle.name]
                            )
                          }
                          loading={isInFlight}
                          disabled={isInFlight || actionInFlight.size > 0}
                          aria-label={`Force payout for ${circle.name}`}
                        >
                          Force Payout
                        </Button>
                      )}
                      {circle.status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            requestConfirm(
                              "pause",
                              [circle.id],
                              [circle.name]
                            )
                          }
                          loading={isInFlight}
                          disabled={isInFlight || actionInFlight.size > 0}
                          aria-label={`Pause ${circle.name}`}
                        >
                          Pause
                        </Button>
                      )}
                      {circle.status === "paused" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            requestConfirm(
                              "resume",
                              [circle.id],
                              [circle.name]
                            )
                          }
                          loading={isInFlight}
                          disabled={isInFlight || actionInFlight.size > 0}
                          aria-label={`Resume ${circle.name}`}
                        >
                          Resume
                        </Button>
                      )}
                      {circle.status !== "completed" &&
                        circle.status !== "cancelled" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              requestConfirm(
                                "cancel",
                                [circle.id],
                                [circle.name]
                              )
                            }
                            loading={isInFlight}
                            disabled={isInFlight || actionInFlight.size > 0}
                            aria-label={`Cancel ${circle.name}`}
                          >
                            Cancel
                          </Button>
                        )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {displayed.length > 0 && (
        <p className={tableStyles.rowCount} aria-live="polite">
          Showing {displayed.length} of {localCircles.length} circle
          {localCircles.length !== 1 ? "s" : ""}
          {someSelected ? ` · ${selectedIds.size} selected` : ""}
        </p>
      )}
    </>
  );
}
