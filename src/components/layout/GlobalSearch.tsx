"use client";

import { useState, useRef, useEffect, useCallback, useId } from "react";
import Link from "next/link";
import type { Circle } from "@/types";
import styles from "./GlobalSearch.module.css";

interface SearchResult {
  id: string;
  name: string;
  status: string;
  memberCount: number;
}

const DEBOUNCE_MS = 300;

async function fetchResults(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const res = await fetch(
    `/api/v1/circles?search=${encodeURIComponent(query)}&limit=8`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return [];
  const json = await res.json();

  // Handle both cursor-paginated shape ({ items }) and legacy shape ({ data })
  const items: Circle[] =
    json?.data?.items ?? (Array.isArray(json?.data?.data) ? json.data.data : json?.data ?? []);

  return items.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    memberCount: (c as Circle & { memberCount?: number }).memberCount ?? 0,
  }));
}

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const listboxId = useId();

  // Debounced search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await fetchResults(query);
        setResults(data);
        setOpen(true);
        setActiveIndex(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const el = inputRef.current?.closest("[data-search-root]");
      if (el && !el.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const handleClear = useCallback(() => {
    setQuery("");
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }, []);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      // Only clear if focus moves outside the entire search widget.
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const root = inputRef.current?.closest("[data-search-root]");
      if (root && relatedTarget && root.contains(relatedTarget)) return;
      // Clear input if user didn't select a result.
      setTimeout(() => {
        setOpen(false);
        setQuery("");
        setResults([]);
      }, 150);
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open || results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        const item = results[activeIndex];
        if (item) {
          window.location.href = `/circles/${item.id}`;
          setOpen(false);
          setQuery("");
        }
      } else if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    },
    [open, results, activeIndex]
  );

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className={styles.container}
      data-search-root=""
      onBlur={handleBlur}
    >
      <div className={styles.inputWrapper}>
        <span className={styles.searchIcon} aria-hidden="true">🔍</span>

        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search circles"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `search-result-${activeIndex}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className={styles.input}
          placeholder="Search circles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        {query && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={handleClear}
            aria-label="Clear search"
            tabIndex={0}
          >
            ✕
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div
          className={styles.dropdown}
          role="listbox"
          id={listboxId}
          aria-label="Search results"
        >
          {loading && (
            <p className={styles.loadingState} aria-live="polite">
              Searching…
            </p>
          )}

          {!loading && results.length === 0 && query.trim() && (
            <p className={styles.emptyState} aria-live="polite">
              No circles found for &ldquo;{query}&rdquo;
            </p>
          )}

          {!loading && results.length > 0 && (
            <ul ref={listRef} className={styles.resultList} role="presentation">
              {results.map((result, idx) => (
                <li key={result.id} role="option" aria-selected={idx === activeIndex}>
                  <Link
                    id={`search-result-${idx}`}
                    href={`/circles/${result.id}`}
                    className={styles.resultItem}
                    data-active={idx === activeIndex ? "true" : "false"}
                    onClick={() => {
                      setOpen(false);
                      setQuery("");
                    }}
                    tabIndex={-1}
                  >
                    <span className={styles.resultName}>{result.name}</span>
                    <span className={styles.resultMeta}>
                      <span className={styles.statusBadge}>{result.status}</span>
                      <span className={styles.memberCount}>{result.memberCount} members</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
