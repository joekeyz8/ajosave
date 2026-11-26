# Managed Secret Rotation

This documents the rotation procedure for every secret currently consumed by
CI/deployment (see `.github/workflows/staging-deploy.yml`, `backup.yml`,
`restore-drill.yml`) and the GitHub Actions repo/environment secrets store.
It is paired with `.github/workflows/secret-rotation-reminder.yml`, which
opens a quarterly tracking issue so rotation doesn't get forgotten.

There is no secrets-manager (Vault/AWS Secrets Manager/etc.) wired into this
repo today — secrets live directly in GitHub Actions repo/environment
secrets. This doc and the reminder workflow are the rotation *process* on
top of that; they do not (and cannot, from CI) rotate third-party
credentials automatically, since that requires calling each provider's
dashboard/API with owner-level credentials this repo does not hold.

## Inventory & rotation steps

| Secret | Used by | Rotation procedure |
|---|---|---|
| `STAGING_NEXTAUTH_SECRET` | staging-deploy.yml | Generate a new random 32+ byte value (`openssl rand -base64 32`), update in repo/environment secrets. Rotating invalidates all existing staging sessions — acceptable on staging. |
| `STAGING_DATABASE_URL`, `DATABASE_URL` | staging-deploy.yml, backup.yml, restore-drill.yml | Rotate the DB user's password at the provider, then update the connection string secret. Do this during low-traffic hours; existing connections drop until app restart picks up the new URL. |
| `STELLAR_TESTNET_SECRET_KEY`, `STELLAR_SERVER_SECRET_KEY` | staging-deploy.yml (contract deploy), faucet | Generate a new Stellar keypair, fund it (testnet: Friendbot; mainnet: transfer from treasury), update the secret, then re-point the contract's admin/server role to the new public key on-chain before rotating out the old key. |
| `STAGING_PAYSTACK_SECRET_KEY` | staging-deploy.yml | Roll the key in the Paystack dashboard (Settings → API Keys → Roll Key), update the secret immediately — Paystack invalidates the old key on roll. |
| `STAGING_TERMII_API_KEY` | staging-deploy.yml | Regenerate in the Termii dashboard, update secret, revoke the old key once confirmed working. |
| `STAGING_REDIS_URL` | staging-deploy.yml | Rotate the Redis auth password/ACL user at the provider, update the secret. |
| `STAGING_CRON_SECRET`, `CRON_SECRET` | staging-deploy.yml, load-test.yml | Internal shared secret used to authorize cron endpoints — generate a new random value and update; no external dependency. |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | staging-deploy.yml | Regenerate the auth token in Sentry (Settings → Auth Tokens); the DSN itself rarely needs rotation unless leaked — if leaked, regenerate the project's client key in Sentry. |
| `VERCEL_TOKEN` | staging-deploy.yml, pr-preview.yml | Revoke and regenerate in Vercel (Account Settings → Tokens), update secret. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | backup.yml, restore-drill.yml | Create a new access key for the IAM user/role, update the secret, verify a manual `workflow_dispatch` run of `restore-drill.yml` succeeds, then deactivate/delete the old key. |
| `SLACK_WEBHOOK_URL` | uptime.yml, backup.yml, restore-drill.yml, load-test.yml | Regenerate the incoming webhook in the Slack app config, update secret, delete the old webhook. |

## Rotation schedule

| Class | Interval | Secrets |
|---|---|---|
| API keys / tokens | **90 days** | `STAGING_PAYSTACK_SECRET_KEY`, `STAGING_TERMII_API_KEY`, `SENTRY_AUTH_TOKEN`, `VERCEL_TOKEN`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `SLACK_WEBHOOK_URL`, `STAGING_REDIS_URL`, `STAGING_DATABASE_URL`/`DATABASE_URL`, `STAGING_CRON_SECRET`/`CRON_SECRET` |
| Signing keys | **180 days** | `STAGING_NEXTAUTH_SECRET`/`NEXTAUTH_SECRET`, `STELLAR_TESTNET_SECRET_KEY`/`STELLAR_SERVER_SECRET_KEY` |

Any leaked or suspected-leaked secret is rotated immediately regardless of schedule.

### Expiry tracking

GitHub Secrets have no native expiry, so expiry is tracked in the quarterly
tracking issue opened by `.github/workflows/secret-rotation-reminder.yml`
(label it and pin it). When a secret is rotated, record in that issue:
secret name, rotation date, owner and next due date (rotation date + interval).
Mirror the next due dates as events in the team's shared on-call calendar.

## Step-by-step runbooks

All runbooks follow the same pattern: **create new → deploy new → verify →
revoke old**. Never revoke the old credential before the new one is verified.

### Paystack (`STAGING_PAYSTACK_SECRET_KEY`, production `PAYSTACK_SECRET_KEY`)
1. Paystack dashboard → Settings → API Keys & Webhooks → Roll key (choose a
   delayed expiry for the old key where offered).
2. Update the GitHub environment secret and the Vercel environment variable.
3. Redeploy (`staging-deploy.yml` or production deploy) and run a test charge.
4. Confirm webhook signature verification still passes, then let the old key expire.

### Stellar (`STELLAR_TESTNET_SECRET_KEY`, `STELLAR_SERVER_SECRET_KEY`)
1. Generate a keypair: `stellar keys generate ajosave-server-<date>`.
2. Fund it (testnet: Friendbot; mainnet: transfer from treasury).
3. Add the new public key as an authorized admin/server signer on the
   contract (multisig — see `docs/multisig-admin.md`) **while keeping the old one**.
4. Update the secret, redeploy, verify a contract call signed by the new key.
5. Remove the old key from the contract signers, then merge its balance back to treasury.

### `CRON_SECRET` / `STAGING_CRON_SECRET`
1. Generate: `openssl rand -base64 32`.
2. Update the app environment variable and redeploy.
3. Update the GitHub secret used by the cron caller / load test in the same window.
4. Trigger a cron endpoint manually and confirm `200`.

### `NEXTAUTH_SECRET` / `STAGING_NEXTAUTH_SECRET`
1. Generate: `openssl rand -base64 32`.
2. Update the environment variable and redeploy during low traffic.
3. Existing sessions are invalidated; users must sign in again. Announce in
   advance for production.

### Database (`DATABASE_URL`, `STAGING_DATABASE_URL`)
1. Create a second DB role (or set a new password on a duplicate role) with
   identical grants.
2. Update the connection string secret / env var and redeploy.
3. Confirm new connections use the new role (`pg_stat_activity`), then drop
   the old role/password.

### Redis (`STAGING_REDIS_URL`)
1. Add a new ACL user/password at the provider alongside the old one.
2. Update the secret, redeploy, verify, then remove the old ACL user.

### Termii, Sentry, Vercel, AWS, Slack
1. Create a new key/token/webhook in the provider dashboard (old one stays active).
2. Update the GitHub secret (and Vercel env var where applicable).
3. Run the dependent workflow (`staging-deploy.yml`, `restore-drill.yml`,
   `uptime.yml`) and confirm it is green.
4. Revoke the old credential.

## Zero-downtime rotation procedure

1. **Overlap:** both old and new credentials must be valid simultaneously.
   Use provider dual-key support (Paystack roll with delay, AWS two access
   keys, DB/Redis second role, Stellar multisig signers).
2. **Deploy new first:** update secrets, then redeploy; Vercel promotes the
   new deployment atomically, so in-flight requests finish on the old one.
3. **Verify:** smoke test the affected flow and check Sentry for auth errors.
4. **Revoke old** only after verification. If verification fails, roll back
   with `production-rollback.yml` — the old credential still works.
5. `NEXTAUTH_SECRET` is the only rotation that is user-visible (session
   logout); schedule it in a maintenance window.

## General rule

1. Never let old and new credentials overlap by more than the time needed to
   confirm the new one works (one CI run / one manual smoke test).
2. Prefer providers that support "roll without downtime" (Paystack, Stripe,
   Vercel tokens) — rotate those most often since it's low-cost.
3. Any secret that appears in a Gitleaks/TruffleHog finding (see
   `SECRETS_SCANNING.md`) must be rotated immediately, not just removed from
   git history.
4. After rotating, confirm the dependent workflow actually ran green before
   closing out the rotation (staging-deploy for app secrets,
   restore-drill for AWS/DB backup secrets, uptime for Slack webhook).
