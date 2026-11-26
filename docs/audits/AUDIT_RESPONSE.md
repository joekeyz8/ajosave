# External Audit Response

Formal response to each completed external contract audit: which findings are
remediated, which are accepted risks, and which are disputed. Process and scope
live in [`docs/external-contract-audit.md`](../external-contract-audit.md); the
running tracker is [`README.md`](README.md).

Create one section per completed audit (copy the block below). Per-finding
detail uses [`FINDING_TEMPLATE.md`](FINDING_TEMPLATE.md).

## Mainnet gate

Mainnet deployment is blocked until **every Critical and High finding** in every
audit below has status `Fixed` with a fix commit/PR reference and a regression
test. `Accepted` and `Disputed` are only allowed for Medium and below.

| Audit | Open Critical | Open High | Mainnet cleared |
|---|---|---|---|
| _No audit completed yet_ | — | — | **No** |

## Status values

| Status | Meaning |
|---|---|
| Fixed | Remediated; fix commit/PR and regression test referenced. |
| Accepted | Risk acknowledged and not fixed; rationale required. Medium and below only. |
| Disputed | Team disagrees with the finding; rationale and auditor reply required. |
| Planned | Fix scheduled; target PR/issue referenced. Not allowed for Critical/High at launch. |

---

## Audit: `<Auditor>` — `<YYYY-MM-DD>`

| Field | Value |
|---|---|
| Report | `<link to report>` |
| Audited commit | `<sha>` |
| Response author | |
| Response date | |

| ID | Severity | Title | Status | Fix commit / PR | Regression test | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
