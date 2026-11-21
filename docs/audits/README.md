# Contract Audit Tracker

Process and scope: [`docs/external-contract-audit.md`](../external-contract-audit.md).

## Audit status

| Field | Value |
|---|---|
| Auditor | _not yet engaged_ |
| Audited commit | _not yet frozen_ |
| Report | _pending_ |
| Mainnet deployment cleared | **No** (requires closed Critical/High findings) |

## Changes since the audited commit

Add an entry whenever `contracts/*/src` changes (CI requires this file or the audit doc to be touched).

| Date | PR | Change | Re-audit needed? |
|---|---|---|---|
| 2026-10-21 | Issue #247 | Return a typed pause error from join, contribute and payout; emit CircleResumed on unpause. | Yes |
| 2026-11-21 | Issue #460 | Add read-only `get_circle_state` view (bumps instance TTL). | Yes |
| | | | |

## Findings

| ID | Severity | Title | Status | Fix commit | Regression test |
|---|---|---|---|---|---|
| | | | | | |

Use [`FINDING_TEMPLATE.md`](FINDING_TEMPLATE.md) for the detail of each finding.
The formal per-audit response lives in [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md).
