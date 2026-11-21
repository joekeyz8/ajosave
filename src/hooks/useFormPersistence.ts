"use client";

import { useEffect, useCallback, useState } from "react";
import type { UseFormReturn, FieldValues } from "react-hook-form";

const STORAGE_VERSION = "v1";

interface UseFormPersistenceOptions {
  /**
   * When true (default), persisted values are restored into the form
   * automatically on mount.
   *
   * When false, restoration is deferred to the caller — typically so a draft
   * can be offered behind a "Continue your draft?" prompt. The caller uses
   * `hasDraft` to detect a saved draft and `restoreDraft()` to apply it only
   * after the user confirms.
   */
  autoRestore?: boolean;
}

interface UseFormPersistenceResult {
  /** Remove the persisted draft from sessionStorage. */
  clearPersistedForm: () => void;
  /** Whether a non-empty persisted draft currently exists in sessionStorage. */
  hasDraft: boolean;
  /**
   * Restore the persisted draft into the form. Returns true when a draft was
   * found and applied, false otherwise. Safe to call after a user confirms
   * they want to continue.
   */
  restoreDraft: () => boolean;
}

/**
 * Persists react-hook-form state to sessionStorage so that validation errors
 * and entered values survive accidental navigation / page refresh.
 *
 * Values are keyed by `storageKey` and scoped to the current browser session
 * (sessionStorage) so they are not shared across tabs and are cleared when the
 * tab is closed – appropriate for sensitive financial form data.
 *
 * @param autoRestore When false, the caller controls restoration (e.g. behind
 *                    a discard prompt) via `hasDraft` + `restoreDraft()`.
 */
export function useFormPersistence<T extends FieldValues>(
  form: UseFormReturn<T>,
  storageKey: string,
  options: UseFormPersistenceOptions = {},
): UseFormPersistenceResult {
  const { autoRestore = true } = options;
  const key = `ajosave:form:${STORAGE_VERSION}:${storageKey}`;

  const [hasDraft, setHasDraft] = useState(false);

  // Detect whether a valid persisted draft exists (runs once on mount).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        setHasDraft(typeof parsed === "object" && parsed !== null);
      }
    } catch {
      // Corrupted data – clear it and treat as no draft.
      sessionStorage.removeItem(key);
    }
    // We only want to run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Restore persisted values on mount when autoRestore is enabled (default).
  useEffect(() => {
    if (!autoRestore) return;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<T>;
      form.reset(saved as T, {
        keepErrors: false,
        keepDirty: false,
        keepDefaultValues: true,
      });
    } catch {
      // Corrupted data – clear and start fresh.
      sessionStorage.removeItem(key);
    }
    // We only want to run this once on mount (plus when the mode toggles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, autoRestore]);

  // Watch all field changes and persist to sessionStorage.
  useEffect(() => {
    const subscription = form.watch((values) => {
      try {
        sessionStorage.setItem(key, JSON.stringify(values));
      } catch {
        // Storage may be full or unavailable – silently fail.
      }
    });
    return () => subscription.unsubscribe();
  }, [form, key]);

  /** Call this after a successful submission to clear the persisted draft. */
  const clearPersistedForm = useCallback(() => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Ignore.
    }
    setHasDraft(false);
  }, [key]);

  /** Imperatively restore the persisted draft (used when autoRestore is false). */
  const restoreDraft = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return false;
      const saved = JSON.parse(raw) as Partial<T>;
      form.reset(saved as T, {
        keepErrors: false,
        keepDirty: false,
        keepDefaultValues: true,
      });
      return true;
    } catch {
      sessionStorage.removeItem(key);
      return false;
    }
  }, [form, key]);

  return { clearPersistedForm, hasDraft, restoreDraft };
}
