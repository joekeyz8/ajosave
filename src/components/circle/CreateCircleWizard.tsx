"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createCircleSchema, type CreateCircleInput } from "@/types/schemas";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFormPersistence } from "@/hooks/useFormPersistence";
import styles from "./CreateCircleWizard.module.css";

const FORM_STORAGE_KEY = "create-circle-wizard";
const TOTAL_STEPS = 3;

const STEP_LABELS = ["Basic Info", "Contribution", "Review"];

// Fields that belong to each step — used for per-step validation.
const STEP_FIELDS: Record<number, (keyof CreateCircleInput)[]> = {
  1: ["name", "circleType", "maxMembers"],
  2: ["contributionAmount", "contributionCurrency", "cycleFrequency", "payoutMethod", "gracePeriodHours"],
  3: [],
};

export function CreateCircleWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateCircleInput>({
    resolver: zodResolver(createCircleSchema),
    mode: "onTouched",
    defaultValues: {
      cycleFrequency: "monthly",
      circleType: "public",
      gracePeriodHours: 24,
      payoutMethod: "fixed",
      yieldStrategy: "none",
      penaltyPercent: 10,
      contributionCurrency: "NGN",
    },
  });

  const {
    register,
    handleSubmit,
    trigger,
    getValues,
    formState: { errors },
  } = form;

  // Persist wizard state to sessionStorage across refreshes.
  const { clearPersistedForm } = useFormPersistence(form, FORM_STORAGE_KEY);

  /** Validate current step's fields then advance. */
  const goNext = useCallback(async () => {
    const fields = STEP_FIELDS[step];
    const valid = fields.length === 0 || (await trigger(fields));
    if (valid) setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }, [step, trigger]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 1));
  }, []);

  /** Handle Enter key on the last field of a step to advance. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && step < TOTAL_STEPS) {
      e.preventDefault();
      goNext();
    }
  };

  const onSubmit = async (data: CreateCircleInput) => {
    setLoading(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/circles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      clearPersistedForm();
      router.push(`/circles/${json.data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const values = getValues();

  return (
    <div className={styles.wizard} aria-label="Create a new savings circle">
      <div>
        <h1 className={styles.title}>Create a Circle</h1>
        <p className={styles.subtitle}>Set up your savings circle in a few steps.</p>
      </div>

      {/* ── Step Progress Indicator ── */}
      <nav aria-label="Form progress" className={styles.stepper}>
        {STEP_LABELS.map((label, idx) => {
          const num = idx + 1;
          const isDone = step > num;
          const isActive = step === num;
          return (
            <div
              key={num}
              className={`${styles.stepItem} ${isDone ? styles.done : ""} ${isActive ? styles.active : ""}`}
            >
              <div className={styles.stepMeta}>
                <div
                  className={styles.stepCircle}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`Step ${num}: ${label}${isDone ? " (completed)" : ""}`}
                >
                  {isDone ? "✓" : num}
                </div>
                <span className={styles.stepLabel}>{label}</span>
              </div>
              {num < TOTAL_STEPS && <div className={styles.stepConnector} aria-hidden="true" />}
            </div>
          );
        })}
      </nav>

      {/* ── Step 1: Basic Info ── */}
      {step === 1 && (
        <fieldset
          className={styles.panel}
          onKeyDown={handleKeyDown}
          aria-labelledby="step1-title"
        >
          <legend id="step1-title" className={styles.panelTitle}>
            Step 1 — Basic Info
          </legend>

          <Input
            label="Circle Name"
            placeholder="e.g. Lagos Girls Monthly Ajo"
            error={errors.name?.message}
            required
            autoFocus
            {...register("name")}
          />

          <div className="input-group">
            <label className="input-label" htmlFor="circleType">
              Circle Type
              <span aria-hidden="true" style={{ color: "var(--color-error)", marginLeft: "0.25em" }}>*</span>
            </label>
            <select
              id="circleType"
              className="input"
              aria-required="true"
              {...register("circleType")}
            >
              <option value="public">Public — anyone can discover and join</option>
              <option value="private">Private — invite link only</option>
            </select>
          </div>

          <Input
            label="Number of Members"
            type="number"
            placeholder="5"
            min={2}
            max={20}
            error={errors.maxMembers?.message}
            required
            hint="Between 2 and 20 members"
            {...register("maxMembers", { valueAsNumber: true })}
          />
        </fieldset>
      )}

      {/* ── Step 2: Contribution Settings ── */}
      {step === 2 && (
        <fieldset
          className={styles.panel}
          onKeyDown={handleKeyDown}
          aria-labelledby="step2-title"
        >
          <legend id="step2-title" className={styles.panelTitle}>
            Step 2 — Contribution Settings
          </legend>

          <Input
            label="Contribution Amount"
            type="number"
            placeholder="10000"
            error={errors.contributionAmount?.message}
            required
            autoFocus
            hint="Minimum contribution amount"
            {...register("contributionAmount", { valueAsNumber: true })}
          />

          <div className="input-group">
            <label className="input-label" htmlFor="contributionCurrency">
              Currency
              <span aria-hidden="true" style={{ color: "var(--color-error)", marginLeft: "0.25em" }}>*</span>
            </label>
            <select
              id="contributionCurrency"
              className="input"
              aria-required="true"
              {...register("contributionCurrency")}
            >
              <option value="NGN">NGN — Nigerian Naira</option>
              <option value="GBP">GBP — British Pound</option>
              <option value="USD">USD — US Dollar</option>
              <option value="EUR">EUR — Euro</option>
            </select>
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="cycleFrequency">
              Cycle Frequency
              <span aria-hidden="true" style={{ color: "var(--color-error)", marginLeft: "0.25em" }}>*</span>
            </label>
            <select
              id="cycleFrequency"
              className="input"
              aria-required="true"
              {...register("cycleFrequency")}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="payoutMethod">
              Payout Order
            </label>
            <select
              id="payoutMethod"
              className="input"
              {...register("payoutMethod")}
            >
              <option value="fixed">Fixed — set order</option>
              <option value="randomized">Randomized — shuffled when circle fills</option>
            </select>
          </div>

          <Input
            label="Grace Period (hours)"
            type="number"
            min={0}
            max={168}
            error={errors.gracePeriodHours?.message}
            hint="How long members have to contribute after cycle starts (0–168 h)"
            {...register("gracePeriodHours", { valueAsNumber: true })}
          />
        </fieldset>
      )}

      {/* ── Step 3: Review & Confirm ── */}
      {step === 3 && (
        <section className={styles.panel} aria-labelledby="step3-title">
          <h2 id="step3-title" className={styles.panelTitle}>
            Step 3 — Review &amp; Confirm
          </h2>

          <dl className={styles.reviewList}>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Circle Name</dt>
              <dd className={styles.reviewValue}>{values.name || "—"}</dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Type</dt>
              <dd className={styles.reviewValue} style={{ textTransform: "capitalize" }}>
                {values.circleType || "—"}
              </dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Max Members</dt>
              <dd className={styles.reviewValue}>{values.maxMembers ?? "—"}</dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Contribution</dt>
              <dd className={styles.reviewValue}>
                {values.contributionCurrency} {values.contributionAmount?.toLocaleString() ?? "—"}
              </dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Frequency</dt>
              <dd className={styles.reviewValue} style={{ textTransform: "capitalize" }}>
                {values.cycleFrequency || "—"}
              </dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Payout Order</dt>
              <dd className={styles.reviewValue} style={{ textTransform: "capitalize" }}>
                {values.payoutMethod || "—"}
              </dd>
            </div>
            <div className={styles.reviewRow}>
              <dt className={styles.reviewLabel}>Grace Period</dt>
              <dd className={styles.reviewValue}>{values.gracePeriodHours ?? 24} hours</dd>
            </div>
          </dl>

          {submitError && (
            <p className={styles.error} role="alert" aria-live="assertive">
              {submitError}
            </p>
          )}
        </section>
      )}

      {/* ── Navigation ── */}
      <div className={styles.nav}>
        {step > 1 ? (
          <Button type="button" variant="ghost" onClick={goBack}>
            ← Back
          </Button>
        ) : (
          <span />
        )}

        {step < TOTAL_STEPS ? (
          <Button type="button" onClick={goNext}>
            Next →
          </Button>
        ) : (
          <Button
            type="button"
            loading={loading}
            onClick={handleSubmit(onSubmit)}
          >
            Create Circle
          </Button>
        )}
      </div>
    </div>
  );
}
