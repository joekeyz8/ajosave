# Metrics Alerting

Ajosave uses GitHub Actions, Slack webhooks, and Sentry to surface operational failures. This document records the existing alerts and the cost controls added for Vercel and Stellar.

## Existing alerting

- `.github/workflows/uptime.yml` pings `/api/health` every 5 minutes and posts to `SLACK_WEBHOOK_URL` on failure.
- `.github/workflows/backup.yml` alerts if the nightly PostgreSQL backup fails.
- `.github/workflows/restore-drill.yml` alerts if the weekly restore drill fails.
- `.github/workflows/load-test.yml` alerts if the scheduled k6 payout load test breaches its latency or error-rate thresholds.
- Sentry collects client, server, and edge errors. Sentry alert rules are configured in the Sentry project dashboard.

## Cost alerting

### Vercel monthly spend

Vercel spend budgets are configured at the team/account level, not in this repository. A Vercel team Owner or Billing role is required to manage the budget.

Configure the production Vercel team with a **$100 monthly spend budget** and enable the spend notifications at **50% ($50)** and **100% ($100)**. Vercel may also provide an intermediate 75% notification depending on the available notification settings. Route the notifications to the billing owners' email addresses, or configure a supported webhook destination if the team wants centralized delivery.

This is intentionally a native Vercel billing control: it measures Vercel's billable usage rather than estimating cost from function invocation counts. Review the budget and recipients whenever the billing plan, projects, or team ownership changes.

**Owner action:** open the Vercel dashboard → Team Settings → Billing / Spend Management (the exact menu label may vary) → create or edit the monthly budget, set it to $100, and enable the 50% and 100% notifications. Confirm that the billing owners receive a test/real notification. Repository changes cannot create this account-level budget without Vercel billing access.

### Stellar daily transaction fees

`.github/workflows/stellar-fee-alert.yml` runs daily at 00:17 UTC and can also be started manually. It queries the configured platform account's Horizon transaction history for the previous UTC calendar day, follows Horizon pagination, sums `fee_charged` values in stroops, converts the result to XLM, and posts to the existing `SLACK_WEBHOOK_URL` when the daily total is **greater than** the configured threshold.

The monitor reads only public account history. It does not need, request, or expose `STELLAR_SERVER_SECRET_KEY`.

Configure these repository Actions variables and secret under Settings → Secrets and variables → Actions:

| Name | Type | Example / purpose |
|---|---|---|
| `STELLAR_NETWORK` | Variable | `mainnet` or `testnet`; displayed in the alert |
| `STELLAR_HORIZON_URL` | Variable | `https://horizon.stellar.org` for mainnet or `https://horizon-testnet.stellar.org` for testnet |
| `STELLAR_FEE_MONITOR_ACCOUNT` | Variable | Public G... address of the platform account that pays transaction fees |
| `STELLAR_DAILY_FEE_THRESHOLD_XLM` | Variable | Daily limit in XLM, e.g. `0.1` |
| `SLACK_WEBHOOK_URL` | Secret | Incoming webhook URL for the cost-alert Slack channel; reuse the existing repository secret |

The monitor validates the account address and threshold, uses integer stroop arithmetic (1 XLM = 10,000,000 stroops), rejects pagination links that leave the configured Horizon host, and fails the workflow if Horizon or Slack returns an error. Missing configuration also fails loudly rather than silently disabling alerts.

**Important:** choose the Horizon endpoint and public account address for the same network as the deployed platform signer. The account address must be the fee-paying platform account (not a member's Freighter wallet). Never add a Stellar secret/seed to GitHub Actions variables or this repository.

### Operational checks

1. Set the Vercel budget and confirm billing notification recipients.
2. Add the Stellar Actions variables and the Slack webhook secret.
3. Run **Stellar Daily Fee Cost Alert** once with `workflow_dispatch` and confirm the workflow completes.
4. For an end-to-end alert test, temporarily set a very small daily XLM threshold, run the workflow, verify the Slack message, then restore the intended threshold.
5. Check the Actions run after any Horizon URL, network, account, or threshold change.

