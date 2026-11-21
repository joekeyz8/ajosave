# Ajo Contract Storage Layout & Migration Guide

Current schema: **`STORAGE_VERSION = 2`** (`src/lib.rs`). All keys are variants
of `DataKey`. Entries are small (`u32`/`u64`/`i128`/`bool`/`Address`) except
`Members` / `PayoutOrder` (vectors, ≤ 20 elements since `max_members ≤ 20`) and
`MemberStats` (one packed struct per member).

## Instance storage

Shares one TTL; bumped by `extend_instance_ttl` (default threshold 1 day,
extend to 7 days; adjustable via `set_ttl_config`).

| Key | Type | Purpose |
|---|---|---|
| `Admin` | `Address` | Circle admin (multisig account on mainnet) |
| `PendingAdmin` | `Address` | Two-step admin transfer target |
| `PendingUpgradeHash` | `BytesN<32>` | Proposed WASM hash (upgrade timelock) |
| `PendingUpgradeTime` | `u64` | Earliest time the upgrade may execute |
| `Token` | `Address` | Contribution token contract |
| `ExpectedIssuer` | `Address` | Expected token issuer (issue #245) |
| `ContributionAmount` | `i128` | Per-cycle contribution |
| `MaxMembers` | `u32` | Circle size (2–20) |
| `CycleIntervalSecs` | `u64` | Seconds between payouts |
| `Members` | `Vec<Address>` | Members in join order |
| `PayoutOrder` | `Vec<u32>` | Permutation of member indices (empty = join order) |
| `CurrentCycle` | `u32` | 0 before start, then 1..=MaxMembers |
| `NextPayoutTime` | `u64` | Earliest timestamp for next payout |
| `Completed` | `bool` | Circle finished |
| `Paused` | `bool` | Admin pause flag |
| `PayoutLock` | `bool` | Reentrancy guard for `payout` (added v1) |
| `StorageVersion` | `u32` | Schema version; absent = v0 |
| `TtlThreshold` | `u32` | Instance TTL threshold override |
| `TtlExtendTo` | `u32` | Instance TTL extend-to override |
| `MaxMissedContributions` | `u32` | Misses allowed before suspension |
| `Suspended(Address)` | `bool` | **Legacy v1** — removed by v1→v2 migration |

## Temporary storage

| Key | Type | Purpose |
|---|---|---|
| `Contributions(Address, u32)` | `bool` | Member paid for cycle; TTL covers the cycle interval + 1 day (min 7 days, capped at max TTL); cleared on completion |

## Persistent storage

TTL: threshold 7 days, extend to 30 days on write.

| Key | Type | Purpose |
|---|---|---|
| `MemberStats(Address)` | `MemberStats` | Packed reputation, circles completed, on-time/total/missed counts, suspended (v2) |
| `MemberReputation(Address)` | `u32` | **Legacy v1** |
| `TotalCirclesCompleted(Address)` | `u32` | **Legacy v1** |
| `OnTimeContributions(Address)` | `u32` | **Legacy v1** |
| `TotalContributions(Address)` | `u32` | **Legacy v1** |
| `MissedContributions(Address)` | `u32` | **Legacy v1** |

Legacy variants must stay in `DataKey` (and keep their position) so the
migration can still read and delete them.

## Migration history

| Version | Change | Migration step |
|---|---|---|
| v0 | Initial layout, no `StorageVersion` key | — |
| v1 | `PayoutLock` reentrancy guard | `from < 1`: set `PayoutLock = false` if missing |
| v2 | Five per-member persistent keys + instance `Suspended` packed into `MemberStats` (issue #254) | `from < 2`: per member, skip if `MemberStats` exists, else pack legacy values and delete legacy keys |

## Writing a migration

1. Never reorder or remove existing `DataKey` variants — append new ones.
2. Bump `STORAGE_VERSION` to `N`.
3. Add an `if from < N { … }` block at the end of `migrate()`:
   - make it idempotent (check before writing, e.g. skip members already migrated);
   - finish by storing `StorageVersion = N` so a re-run skips the step;
   - make no cross-contract calls (keeps `migrate` non-reentrant).
4. Keep each step within Soroban CPU/memory limits; a transaction that fails
   reverts entirely, and because every completed step records its version,
   re-invoking `migrate()` resumes from the first unfinished step.
5. Add a test that seeds the old layout (and a partially migrated state) and
   asserts values survive and `StorageVersion == N` (see
   `migrate_recovers_from_interrupted_v1_to_v2` in `src/policy_tests.rs`).
6. Add a row to the migration history table above and follow `UPGRADE.md`:
   `upgrade()` then `migrate()` immediately after.
