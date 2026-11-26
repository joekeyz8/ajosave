"use client";

/**
 * CircleCreatedToast
 *
 * Reads a one-shot "circle_created_toast" entry from sessionStorage and fires
 * a success toast immediately on mount. The entry is set by CreateCircleWizard
 * before it navigates to the new circle's detail page.
 *
 * Requirements satisfied:
 *  - Toast fires immediately after redirect (issue #393)
 *  - Toast message includes the circle name
 *  - Toast is announced to screen readers via aria-live (handled by ToastProvider)
 *  - Toast auto-dismisses after 5 s (success variant uses 4 s per toast-policy;
 *    we use "info" variant which is 5 s per TOAST_DURATIONS in toast-policy.ts)
 */

import { useEffect } from "react";
import { useToast } from "@/components/ui/Toast";

export function CircleCreatedToast() {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;

    const raw = sessionStorage.getItem("circle_created_toast");
    if (!raw) return;

    // Consume immediately so it only fires once per navigation.
    sessionStorage.removeItem("circle_created_toast");

    try {
      const { name } = JSON.parse(raw) as { name: string };
      if (name) {
        // "info" variant has a 5 s auto-dismiss per TOAST_DURATIONS in toast-policy.ts.
        toast(`"${name}" was created successfully!`, "info");
      }
    } catch {
      /* malformed entry — silently ignore */
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
