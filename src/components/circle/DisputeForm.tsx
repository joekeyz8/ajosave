"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useCircleInvalidation } from "@/lib/queryInvalidation";
import styles from "./DisputeForm.module.css";

interface DisputeFormProps {
  circleId: string;
  contributionId?: string;
  memberId: string;
  onSuccess?: () => void;
}

export function DisputeForm({ circleId, contributionId, memberId, onSuccess }: DisputeFormProps) {
  const t = useTranslations("dispute");
  const router = useRouter();
  const { invalidateCircle } = useCircleInvalidation();
  const [type, setType] = useState<"missed_payout" | "wrong_amount" | "other">("other");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [paystackRef, setPaystackRef] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`/api/circles/${circleId}/disputes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contributionId: contributionId || undefined,
          memberId,
          type,
          reason,
          evidence: evidence || undefined,
          paystackReference: paystackRef || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("errorFallback"));
      }

      setReason("");
      setEvidence("");
      setPaystackRef("");
      onSuccess?.();
      invalidateCircle(circleId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h3 className={styles.title}>{t("title")}</h3>

      <div className={styles.field}>
        <label htmlFor="type" className={styles.label}>{t("typeLabel")} *</label>
        <select
          id="type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className={styles.select}
          required
        >
          <option value="missed_payout">{t("typeMissedPayout")}</option>
          <option value="wrong_amount">{t("typeWrongAmount")}</option>
          <option value="other">{t("typeOther")}</option>
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="reason" className={styles.label}>{t("descriptionLabel")} *</label>
        <textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("descriptionPlaceholder")}
          className={styles.textarea}
          required
          minLength={10}
          maxLength={500}
        />
        <span className={styles.hint}>{reason.length}/500</span>
      </div>

      <div className={styles.field}>
        <label htmlFor="evidence" className={styles.label}>{t("evidenceLabel")}</label>
        <textarea
          id="evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder={t("evidencePlaceholder")}
          className={styles.textarea}
          maxLength={1000}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="paystack" className={styles.label}>{t("paystackLabel")}</label>
        <Input
          id="paystack"
          type="text"
          value={paystackRef}
          onChange={(e) => setPaystackRef(e.target.value)}
          placeholder={t("paystackPlaceholder")}
        />
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <Button
        type="submit"
        disabled={loading || !reason.trim()}
        loading={loading}
        className={styles.submit}
      >
        {t("submit")}
      </Button>
    </form>
  );
}
