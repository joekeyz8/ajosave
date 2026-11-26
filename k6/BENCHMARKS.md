# k6 Performance Benchmarks

The payout load test (`k6/payout-load-test.js`) runs in CI against staging
after every deploy (`load-test-staging` job in
`.github/workflows/staging-deploy.yml`). A threshold breach fails the job and
blocks the downstream testnet contract deploy.

## Thresholds

| Metric | Threshold |
|---|---|
| Virtual users | 50 (30 s) |
| `http_req_duration` p95 | < 500 ms |
| `payout_error_rate` | < 0.1 % |

## Baseline history

Each CI run appends a row below (published in the job summary and the
`k6-staging-results` artifact). Commit the updated table periodically to keep
the baseline current.

| Date | Commit | p95 (ms) | Error rate (%) | Requests |
|---|---|---|---|---|
