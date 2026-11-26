# Contract Upgrade Guide

The Ajo contract exposes an admin-only, two-step **upgrade governance**
flow that replaces the running WASM in-place using Soroban's
`update_current_contract_wasm`. All storage (members, cycles, balances) is
preserved across upgrades.

1. `propose_upgrade(new_wasm_hash)` — admin proposes a new WASM hash and
   starts a 48-hour timelock (`UPGRADE_TIMELOCK_SECS`), emitting an
   `upgrade_proposed` event with the hash and the earliest execution time.
   This is the governance boundary for #55: it gives circle members a
   window to notice a pending upgrade (via the emitted event / an indexer)
   and exit before new logic goes live, instead of an admin being able to
   swap the contract instantly and unilaterally.
2. `cancel_upgrade()` — admin may cancel a pending proposal at any time
   before it executes, emitting `upgrade_cancelled`.
3. `upgrade(new_wasm_hash)` — executes a previously proposed upgrade.
   Reverts if there is no pending proposal, if `new_wasm_hash` doesn't
   match the proposed hash, or if the timelock hasn't elapsed yet.

## Prerequisites

- Stellar CLI installed (`stellar --version`)
- Admin keypair available
- New contract code compiled to WASM

## Steps

### 1. Build the new WASM

```bash
npm run contract:build
# Output: contracts/ajo/target/wasm32-unknown-unknown/release/ajo.wasm
```

### 2. Upload the WASM blob (does not deploy a new contract)

```bash
stellar contract upload \
  --network testnet \
  --source <ADMIN_SECRET_KEY> \
  --wasm contracts/ajo/target/wasm32-unknown-unknown/release/ajo.wasm
# Prints: <NEW_WASM_HASH>
```

### 3. Propose the upgrade

```bash
stellar contract invoke \
  --network testnet \
  --source <ADMIN_SECRET_KEY> \
  --id <CONTRACT_ID> \
  -- propose_upgrade \
  --new_wasm_hash <NEW_WASM_HASH>
```

This starts the 48-hour governance timelock and emits `upgrade_proposed`.
Wait for the timelock to elapse (or `cancel_upgrade` to abort).

### 4. Execute the upgrade

```bash
stellar contract invoke \
  --network testnet \
  --source <ADMIN_SECRET_KEY> \
  --id <CONTRACT_ID> \
  -- upgrade \
  --new_wasm_hash <NEW_WASM_HASH>
```

The contract emits an `upgraded` event containing the new WASM hash. Verify it in Stellar Explorer or via:

```bash
stellar events --contract-id <CONTRACT_ID> --topic upgraded
```

### 5. Verify

```bash
stellar contract invoke \
  --network testnet \
  --source <ADMIN_SECRET_KEY> \
  --id <CONTRACT_ID> \
  -- get_state
```

Confirm the circle state is intact and the new logic is active.

## Verifying a WASM artifact

Every GitHub release runs `.github/workflows/contract-wasm-release.yml`,
which rebuilds `ajo.wasm` and `certificate.wasm` from source and publishes
them on the release alongside a `SHA256SUMS.txt`. Before trusting a
`<NEW_WASM_HASH>` used in step 3 above, rebuild locally and compare:

```bash
npm run contract:build
sha256sum contracts/target/wasm32-unknown-unknown/release/*.wasm
# Compare against the release's SHA256SUMS.txt and against the hash
# printed by `stellar contract upload` in step 2.
```

## Notes

- Only the `admin` address set during `initialize` can call `upgrade`.
- No data migration is needed unless the new version changes storage key layouts — in that case add a `migrate()` function before calling `upgrade`.
- For mainnet upgrades, test on testnet first and have the admin multisig approve the transaction.

## Admin Rotation vs. Upgrade Timelock (Issue #443)

**Threat:** if the admin address could change between `propose_upgrade` and
`upgrade`, a newly rotated-in admin could inherit or replace the pending
proposal and shorten the window members have to react to a WASM swap.

**Mitigation:** admin rotation is frozen while an upgrade is pending.

- `propose_admin` and `accept_admin` panic with
  `"admin change blocked while upgrade is pending"` whenever
  `PendingUpgradeHash` is set — including an admin proposed *before* the
  upgrade was proposed.
- To rotate the admin, the current admin must first `cancel_upgrade`. Any
  subsequent upgrade by the new admin requires a fresh `propose_upgrade`,
  which starts a new full 48-hour timelock.
- The timelock is tied to the proposed WASM hash and its `PendingUpgradeTime`,
  never to the proposer, so no admin can execute an upgrade earlier than
  `UPGRADE_TIMELOCK_SECS` after it was proposed.

Covered by `test_admin_rotation_blocked_during_pending_upgrade`,
`test_accept_admin_blocked_during_pending_upgrade` and
`test_admin_rotation_restarts_timelock` in `src/integration_tests.rs`.
