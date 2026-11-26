"use client";

/**
 * SectionErrorBoundary
 *
 * A React class error boundary that wraps a single section of the circle
 * detail page (chat, timeline/payout history, member list, etc.).
 *
 * When a child component throws, only that section is replaced by a
 * "Something went wrong" fallback; the rest of the page keeps working.
 *
 * Telemetry:
 *  - Errors are reported to Sentry via captureException with the React
 *    component stack attached as extra context (issue #400).
 *  - The boundary tag and section name are set so engineers can filter in
 *    the Sentry issue stream.
 */

import React from "react";
import * as Sentry from "@sentry/nextjs";
import styles from "./SectionErrorBoundary.module.css";

// ── Props / State ──────────────────────────────────────────────────────────

interface Props {
  /** Human-readable section label used in Sentry tags and the fallback UI. */
  section: string;
  children: React.ReactNode;
  /** Optional custom fallback rendered instead of the default UI. */
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorId: string | null;
}

// ── Class boundary ─────────────────────────────────────────────────────────

export class SectionErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorId: null };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    Sentry.withScope((scope) => {
      scope.setTag("boundary", "section");
      scope.setTag("section", this.props.section);
      scope.setTag("error.type", error.name ?? "UnknownError");
      if (typeof window !== "undefined") {
        scope.setTag("page.url", window.location.pathname);
      }
      scope.setExtra("componentStack", info.componentStack ?? "(unavailable)");
      scope.setExtra("errorMessage", error.message ?? "(no message)");
      scope.setExtra("errorStack", error.stack ?? "(no stack)");
      scope.setExtra("section", this.props.section);

      const eventId = Sentry.captureException(error);
      this.setState({ errorId: eventId ?? null });
    });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, errorId: null });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <SectionErrorFallback
        section={this.props.section}
        onRetry={this.handleRetry}
      />
    );
  }
}

// ── Default fallback UI ────────────────────────────────────────────────────

interface FallbackProps {
  section: string;
  onRetry: () => void;
}

function SectionErrorFallback({ section, onRetry }: FallbackProps) {
  return (
    <div className={styles.fallback} role="alert" aria-live="assertive">
      <span className={styles.icon} aria-hidden="true">⚠</span>
      <p className={styles.message}>
        <strong>{section}</strong> could not be displayed.
      </p>
      <p className={styles.sub}>Something went wrong in this section.</p>
      <button className={styles.retryBtn} onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}
