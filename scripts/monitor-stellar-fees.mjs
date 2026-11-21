#!/usr/bin/env node

const STROOPS_PER_XLM = 10_000_000n;
const ACCOUNT_ID_PATTERN = /^G[A-Z2-7]{55}$/;

export function xlmToStroops(value) {
  const input = String(value ?? "").trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,7}))?$/.exec(input);
  if (!match) throw new Error("STELLAR_DAILY_FEE_THRESHOLD_XLM must be a non-negative XLM amount with up to 7 decimal places.");
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(7, "0") || "0");
  return whole * STROOPS_PER_XLM + fractional;
}

export function formatStroops(stroops) {
  const amount = BigInt(stroops);
  const whole = amount / STROOPS_PER_XLM;
  const fraction = String(amount % STROOPS_PER_XLM).padStart(7, "0");
  return `${whole}.${fraction}`;
}

export function sumTransactionFees(transactions, start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("Invalid UTC reporting window.");
  }

  return transactions.reduce((total, transaction) => {
    const createdAt = new Date(transaction.created_at).getTime();
    if (!Number.isFinite(createdAt) || createdAt < startMs || createdAt >= endMs) return total;
    if (!/^\d+$/.test(String(transaction.fee_charged ?? ""))) {
      throw new Error("Horizon returned a transaction with an invalid fee_charged value.");
    }
    return total + BigInt(transaction.fee_charged);
  }, 0n);
}

async function fetchDailyTransactions({ horizonUrl, accountId, start, end, fetchImpl }) {
  const base = new URL(horizonUrl);
  if (!["https:", "http:"].includes(base.protocol)) throw new Error("STELLAR_HORIZON_URL must use HTTP(S).");
  const firstPage = new URL(`/accounts/${accountId}/transactions`, base);
  firstPage.search = new URLSearchParams({
    limit: "200",
    order: "asc",
    start_time: start,
    end_time: end,
  }).toString();

  const transactions = [];
  let nextUrl = firstPage;
  let pageCount = 0;

  while (nextUrl) {
    if (nextUrl.origin !== base.origin) throw new Error("Horizon pagination returned a URL outside the configured Horizon host.");
    if (++pageCount > 100) throw new Error("Horizon pagination exceeded the 100-page safety limit.");

    const response = await fetchImpl(nextUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?._embedded?.records)) {
      throw new Error("Horizon returned an unexpected transactions response.");
    }
    transactions.push(...payload._embedded.records);

    const nextHref = payload?._links?.next?.href;
    nextUrl = nextHref ? new URL(nextHref, base) : null;
  }

  return transactions;
}

async function postSlackAlert(webhookUrl, message, fetchImpl) {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!response.ok) throw new Error(`Slack webhook failed: HTTP ${response.status}`);
}

export async function runFeeMonitor(env = process.env, fetchImpl = fetch, now = new Date()) {
  const accountId = env.STELLAR_FEE_MONITOR_ACCOUNT?.trim();
  const threshold = xlmToStroops(env.STELLAR_DAILY_FEE_THRESHOLD_XLM);
  const horizonUrl = env.STELLAR_HORIZON_URL?.trim();
  const slackWebhook = env.SLACK_WEBHOOK_URL?.trim();

  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
    throw new Error("STELLAR_FEE_MONITOR_ACCOUNT must be a public Stellar G... account address.");
  }
  if (!horizonUrl) throw new Error("STELLAR_HORIZON_URL is required.");
  if (!slackWebhook || !/^https:\/\//.test(slackWebhook)) {
    throw new Error("SLACK_WEBHOOK_URL must be configured as an HTTPS GitHub Actions secret.");
  }

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const transactions = await fetchDailyTransactions({
    horizonUrl,
    accountId,
    start: startIso,
    end: endIso,
    fetchImpl,
  });
  const totalFees = sumTransactionFees(transactions, startIso, endIso);

  if (totalFees > threshold) {
    const network = env.STELLAR_NETWORK?.trim() || "configured Horizon network";
    const message = [
      ":warning: *Ajosave Stellar fee budget exceeded*",
      `Network: ${network}`,
      `Account: ${accountId}`,
      `UTC period: ${startIso} to ${endIso}`,
      `Fees charged: ${formatStroops(totalFees)} XLM across ${transactions.length} account transactions`,
      `Daily threshold: ${formatStroops(threshold)} XLM`,
    ].join("\n");
    await postSlackAlert(slackWebhook, message, fetchImpl);
    console.log(`Fee threshold exceeded: ${formatStroops(totalFees)} XLM > ${formatStroops(threshold)} XLM. Slack alert sent.`);
    return { alerted: true, totalFees, threshold, transactionCount: transactions.length };
  }

  console.log(`Daily Stellar fees: ${formatStroops(totalFees)} XLM across ${transactions.length} account transactions; threshold: ${formatStroops(threshold)} XLM. No alert required.`);
  return { alerted: false, totalFees, threshold, transactionCount: transactions.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFeeMonitor().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
