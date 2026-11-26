"use client";

import { useState } from "react";
import styles from "./TemplateSelector.module.css";
import { CircleTemplate } from "@/data/circleTemplates";

interface TemplateSelectorProps {
  templates: CircleTemplate[];
  activeTemplateId: string | null;
  onSelect: (_template: CircleTemplate | null) => void;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  GBP: "£",
  USD: "$",
  EUR: "€",
};

function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

function formatFrequency(frequency: string): string {
  switch (frequency) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Bi-weekly";
    case "monthly":
      return "Monthly";
    default:
      return frequency;
  }
}

function formatCircleType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatPayoutMethod(method: string): string {
  switch (method) {
    case "fixed":
      return "Fixed order";
    case "random":
      return "Random order";
    case "bid":
      return "Highest bidder";
    default:
      return method;
  }
}

/** Full-detail modal shown when the user clicks "Preview" on a template card. */
interface PreviewModalProps {
  template: CircleTemplate;
  isActive: boolean;
  onClose: () => void;
  onSelect: () => void;
}

function PreviewModal({ template, isActive, onClose, onSelect }: PreviewModalProps) {
  const symbol = getCurrencySymbol(template.values.contributionCurrency);
  const { values } = template;

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") onClose();
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={styles.modalBackdrop}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-preview-title"
    >
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 id="template-preview-title" className={styles.modalTitle}>
            {template.name}
          </h2>
          <button
            type="button"
            className={styles.modalClose}
            aria-label="Close preview"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <p className={styles.modalDescription}>{template.description}</p>

        <dl className={styles.modalDetails}>
          <div className={styles.modalRow}>
            <dt>Contribution</dt>
            <dd>
              {symbol}
              {values.contributionAmount.toLocaleString()}{" "}
              <span className={styles.modalCurrency}>{values.contributionCurrency}</span>
            </dd>
          </div>
          <div className={styles.modalRow}>
            <dt>Frequency</dt>
            <dd>{formatFrequency(values.cycleFrequency)}</dd>
          </div>
          <div className={styles.modalRow}>
            <dt>Max members</dt>
            <dd>{values.maxMembers}</dd>
          </div>
          <div className={styles.modalRow}>
            <dt>Circle type</dt>
            <dd>{formatCircleType(values.circleType)}</dd>
          </div>
          <div className={styles.modalRow}>
            <dt>Payout method</dt>
            <dd>{formatPayoutMethod(values.payoutMethod)}</dd>
          </div>
          <div className={styles.modalRow}>
            <dt>Grace period</dt>
            <dd>{values.gracePeriodHours}h</dd>
          </div>
        </dl>

        <div className={styles.modalActions}>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onSelect();
              onClose();
            }}
          >
            {isActive ? "Already selected" : "Use this template"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TemplateSelector({
  templates,
  activeTemplateId,
  onSelect,
}: TemplateSelectorProps) {
  const isBlankActive = activeTemplateId === null;
  const [previewTemplate, setPreviewTemplate] = useState<CircleTemplate | null>(null);

  return (
    <div className={styles.container}>
      <div className={styles.scrollRow} role="group" aria-label="Circle templates">
        {/* Blank card */}
        <button
          type="button"
          className={`${styles.card} ${isBlankActive ? styles.cardActive : ""}`}
          aria-pressed={isBlankActive}
          onClick={() => onSelect(null)}
        >
          <span className={styles.cardName}>Blank</span>
          <span className={styles.cardMeta}>Start from scratch</span>
        </button>

        {/* Template cards */}
        {templates.map((template) => {
          const isActive = template.id === activeTemplateId;
          const symbol = getCurrencySymbol(template.values.contributionCurrency);
          return (
            <div key={template.id} className={styles.cardWrapper}>
              <button
                type="button"
                className={`${styles.card} ${isActive ? styles.cardActive : ""}`}
                aria-pressed={isActive}
                onClick={() => onSelect(template)}
              >
                <span className={styles.cardName}>{template.name}</span>
                <span className={styles.cardAmount}>
                  {symbol}
                  {template.values.contributionAmount.toLocaleString()}
                </span>
                <span className={styles.cardMeta}>
                  {template.values.maxMembers} members ·{" "}
                  {formatFrequency(template.values.cycleFrequency)}
                </span>
              </button>
              <button
                type="button"
                className={styles.previewBtn}
                aria-label={`Preview ${template.name} template`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewTemplate(template);
                }}
              >
                Preview
              </button>
            </div>
          );
        })}
      </div>

      {previewTemplate && (
        <PreviewModal
          template={previewTemplate}
          isActive={previewTemplate.id === activeTemplateId}
          onClose={() => setPreviewTemplate(null)}
          onSelect={() => onSelect(previewTemplate)}
        />
      )}
    </div>
  );
}
