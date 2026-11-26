# Deployment Approval & Rollback

## Approval gate (one-time admin setup required)

`.github/workflows/production-deploy.yml` and
`.github/workflows/production-rollback.yml` both run under the
`production` GitHub Environment. As of this writing that environment
exists (it's already used by `backup.yml`/`restore-drill.yml`) but has
**no protection rules**, so the workflows will currently run
unattended. To actually get an approval gate, a repo admin needs to do,
once, in **Settings → Environments → production**:

1. Enable **Required reviewers** and add the people who should approve a
   production deploy or rollback.
2. Optionally restrict **Deployment branches** to `main` and release tags.

This is a repository setting, not something a workflow file can turn on —
this repo/fork does not have admin rights on `joekeyz8/ajosave` to do it
directly, hence documenting it here rather than silently shipping an
unenforced "gate."

Once configured, any run of `production-deploy.yml` or
`production-rollback.yml` will pause in "Waiting" state until a required
reviewer approves it from the Actions run page.

## Database migration rollback

Deploys now run `npm run migrate` automatically: staging on every push to
`main` (before the Vercel preview deploy), production inside
`production-deploy.yml` after the approval gate and **before** the Vercel
traffic shift. The runner records each applied migration in the
`pgmigrations` table, so re-running it is idempotent — only pending
migrations execute. Migration output is uploaded as a workflow artifact
(`staging-migration-logs` / `production-migration-logs`), and a failed
migration aborts the deployment and files a GitHub issue linking to the
run logs.

If a bad migration ships:

1. **Roll back the last migration** from any machine that can reach the
   database: `DATABASE_URL=... npm run migrate down` (rolls back exactly
   one migration). Fix forward with a new migration when possible.
2. **Or roll back the app first** with the **Rollback Production**
   workflow, then roll back / fix the migration, then redeploy. Keep
   migrations compatible with the previous release (expand/contract
   pattern: add before migrate, drop only after the old version is gone)
   so the old app keeps running against the newer schema.

## Rollback path

`production-rollback.yml` (workflow_dispatch):

- With no input, it looks up the two most recent **successful** GitHub
  Deployments recorded against the `production` environment (recorded by
  `production-deploy.yml`/itself via the Deployments API) and redeploys the
  commit before the current one.
- With `to_sha` given explicitly, it checks out and redeploys that commit
  instead — use this to jump further back than one release.

Both the forward deploy and the rollback build the app from the target
commit and push it to Vercel with `--prod`, so a rollback is really "deploy
the old commit again," which is the reliable option here since we do not
have a separate artifact registry of built bundles.

### Contract caveat

If a production incident involves the Soroban contract itself (not just
the Next.js app), rolling back the app deployment does **not** roll back
on-chain contract state or a bad contract upgrade — Soroban contracts are
immutable once deployed except via their own upgrade mechanism. Rolling
back the app to point at a previously-known-good `STELLAR_AJO_CONTRACT_ID`
is a separate, manual decision and is out of scope for this workflow.

## Canary Deployments

Canary deployments allow you to shift a small percentage of traffic to a new
version before rolling it out to 100% of users. This reduces the blast radius
of bad deploys by catching issues early.

### How it works

The `canary-deploy.yml` workflow implements a canary deployment strategy:

1. **Deploy to Preview**: The new version is deployed as a Vercel preview deployment
2. **Traffic Split**: Cloudflare Workers route a configurable percentage (default 5%)
   of traffic to the canary, with the remainder going to production
3. **Observation Period**: The canary runs for a configurable duration (default 10 minutes)
4. **Metrics Monitoring**: Error rate and latency are monitored via Sentry and Prometheus
5. **Decision**: If error rate exceeds threshold (default 1%), automatic rollback occurs.
   Otherwise, the canary is promoted to full production.

### Prerequisites

Canary deployments require:

1. **Cloudflare Workers** for traffic splitting:
   - Create a Cloudflare Worker named `ajosave-canary-router`
   - Configure it to route traffic between production and canary URLs
   - Add the following secrets to GitHub:
     - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
     - `CLOUDFLARE_API_TOKEN`: API token with Workers script edit permissions

2. **Cloudflare Worker Script** (example):
   ```javascript
   export default {
     async fetch(request, env) {
       const canaryUrl = env.CANARY_URL;
       const productionUrl = env.PRODUCTION_URL;
       const trafficPercentage = parseInt(env.TRAFFIC_PERCENTAGE || '5');
       
       const random = Math.random() * 100;
       const targetUrl = random < trafficPercentage ? canaryUrl : productionUrl;
       
       const url = new URL(request.url);
       const target = new URL(targetUrl);
       url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
       
       const modifiedRequest = new Request(target, {
         method: request.method,
         headers: request.headers,
         body: request.body,
         redirect: 'manual'
       });
       
       // Add deployment header for metrics
       modifiedRequest.headers.set('X-Deployment', random < trafficPercentage ? 'canary' : 'production');
       
       return fetch(modifiedRequest);
     }
   };
   ```

3. **Grafana Dashboard** for canary metrics:
   - Import `docs/grafana-canary-dashboard.json` into your Grafana instance
   - Configure Prometheus data source to collect metrics from your application
   - Required metrics (exposed by the application):
     - `ajosave_http_requests_total`: Total HTTP requests (with `status`, `deployment` labels)
     - `ajosave_http_request_duration_seconds_bucket`: Request latency histogram
     - `ajosave_db_query_duration_seconds_bucket`: Database query latency histogram
     - `ajosave_canary_traffic_percentage`: Current traffic split percentage
     - `ajosave_canary_status`: Canary deployment status (0=rollback, 1=promoted, 2=in-progress)
     - `ajosave_canary_deployments`: Canary deployment history table

### Running a canary deployment

1. Go to **Actions → Canary Deploy to Production**
2. Click **Run workflow**
3. Configure parameters:
   - `ref`: Git ref to deploy (default: `main`)
   - `traffic_percentage`: Percentage of traffic to canary (default: `5`)
   - `duration_minutes`: Observation duration (default: `10`)
   - `error_threshold`: Error rate threshold for rollback (default: `1.0`)
4. Click **Run workflow**

The workflow will:
- Deploy the canary to a Vercel preview URL
- Configure Cloudflare Worker to split traffic
- Monitor metrics for the specified duration
- Automatically promote or rollback based on error rate
- Remove traffic split configuration after decision

### Monitoring canary deployments

Monitor canary deployments in Grafana using the **Ajosave Canary Deployment Metrics** dashboard:

- **Error Rate - Production vs Canary**: Compare error rates between versions
- **Request Latency - P95**: Compare latency percentiles
- **Request Rate - RPS**: Compare request throughput
- **Traffic Split Percentage**: Current traffic allocation
- **Canary Status**: Current deployment status
- **Error Rate by Status Code**: Breakdown of error types
- **Database Query Latency**: Database performance comparison
- **Canary Deployment Timeline**: History of canary deployments

The dashboard includes an alert that triggers when canary error rate exceeds 1%.

### Automatic rollback

If the error rate exceeds the threshold during the observation period:

1. The workflow automatically removes the traffic split
2. Traffic is restored 100% to the previous production version
3. A GitHub issue is created with details:
   - Error rate observed
   - Threshold value
   - Commit SHA
   - Link to workflow run logs
4. The canary preview deployment remains available for debugging

### Manual intervention

You can manually trigger a rollback at any time:

1. Run the **Rollback Production** workflow
2. This will redeploy the previous successful version
3. The canary traffic split will be removed as part of the rollback

### Canary vs Full Production Deploy

- **Canary Deploy** (`canary-deploy.yml`): Use for most production releases
  - 5% traffic initially, monitors for 10 minutes
  - Automatic rollback on high error rate
  - Reduces blast radius of bad deploys

- **Full Production Deploy** (`production-deploy.yml`): Use for emergency fixes
  - Immediate 100% traffic shift
  - Requires manual approval
  - Bypasses canary observation period
