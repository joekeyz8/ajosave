# Mainnet Runbook

Operational procedures for deploying and running Ajosave on mainnet.

## Key Signing Policy

All privileged operations (contract upgrades, treasury withdrawals, parameter changes) must be authorized by signatures that satisfy the policy below. The policy is enforced on-chain by the `KeySigningPolicy` contract and mirrored off-chain by the operations tooling.

### Key roles

| Role | Purpose | Threshold | Key type |
|------|---------|-----------|----------|
| `ADMIN` | Contract upgrades, policy changes | 2-of-3 | Hardware wallet (Ledger/Trezor) |
| `TREASURY` | Withdrawals above the daily limit | 3-of-5 | Hardware wallet |
| `OPERATOR` | Routine parameter updates, pauses | 1-of-2 | Hardware wallet |

- Keys are generated and stored exclusively on hardware wallets. No hot keys may hold an `ADMIN` or `TREASURY` role.
- Each signer is a distinct individual; no single person may hold more than one key in the same role.
- Key rotation requires an `ADMIN`-threshold signature and a 48-hour timelock before the new key set becomes active.

### Signing workflow

1. The proposer builds the transaction and computes the canonical payload hash (`keccak256` of the ABI-encoded call, chain id, and nonce).
2. The payload hash is distributed to the required signers out-of-band (encrypted channel). Signers independently verify the decoded call against the intended operation before signing.
3. Signatures are collected and submitted to `KeySigningPolicy.execute`. The contract validates:
   - the signer set matches the active key set for the role,
   - the number of valid signatures meets the role threshold,
   - the nonce has not been used (replay protection),
   - the payload hash matches the submitted call data.
4. On success the operation executes and the nonce is consumed. On failure the transaction reverts and no state changes.

### Validation and authorization

- Every privileged entry point calls `KeySigningPolicy.requireAuthorized(role, payloadHash, signatures)` before mutating state.
- Signatures from keys not in the active set for the role are rejected.
- Duplicate signatures from the same signer are rejected.
- Expired or not-yet-active keys (during rotation timelock) are rejected.

### Failure and retry handling

- A reverted signing transaction consumes no nonce; the operation may be retried with a corrected payload or additional signatures.
- If a signer is unavailable, the operation waits for the threshold rather than lowering it. Thresholds may only be changed via the `ADMIN` policy-change flow.
- If a key is suspected compromised, immediately initiate emergency rotation: pause privileged operations, rotate the affected role's key set, and re-verify outstanding proposals.

### Boundary cases

- Nonce gaps: nonces are strictly sequential per role; a gap indicates a dropped or replayed submission and must be investigated before proceeding.
- Threshold edge: exactly-threshold signatures are valid; below-threshold reverts.
- Zero-value or no-op calls still require full authorization.
- Chain-id mismatch (cross-chain replay) is rejected by the payload hash binding.

### Observability

- Emit `SignatureCollected`, `PolicyExecuted`, and `PolicyRejected` events from `KeySigningPolicy`.
- Alert on: any `PolicyRejected` event, repeated failed signing attempts (>3 in 10 minutes), and any key rotation initiation.
- Dashboards track signing latency, rejection rate, and active key-set version.

### CI enforcement

- `ci/key-signing-policy` runs the policy unit and integration tests (threshold, replay, rotation, boundary cases) on every pull request.
- A static scan verifies no privileged entry point bypasses `requireAuthorized`.
- Merges to `main` are blocked if either check fails.

## Deployment

See `DEPLOYMENT.md` for the deployment sequence.
