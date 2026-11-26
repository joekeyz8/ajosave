//! Ajosave Ajo Contract
//!
//! A trustless rotating savings circle (Ajo/Esusu) on Stellar Soroban.
//!
//! ## Lifecycle
//! 1. `initialize` — admin sets up the circle parameters
//! 2. `join`       — members join by locking their first contribution
//! 3. `contribute` — members pay each cycle
//! 4. `payout`     — admin triggers rotation payout after cycle time
//! 5. Circle completes when all members have received their payout
//!
//! ## Storage Optimization
//! - Instance storage: Core circle configuration (survives entire contract lifetime)
//! - Temporary storage: Contribution tracking (cleared when circle completes)
//! - Persistent storage: Packed per-member records (reputation, counts, suspension)

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, panic_with_error, token, vec, Address, BytesN, Env, Symbol,
    Vec,
};

// ─── Schema version ───────────────────────────────────────────────────────────
/// Bump this constant whenever the storage layout changes in a new deployment.
/// `migrate()` uses it to gate and sequence migration logic.
const STORAGE_VERSION: u32 = 3;

// ─── TTL Configuration ────────────────────────────────────────────────────────
const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = DAY_IN_LEDGERS;
const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TEMP_LIFETIME_THRESHOLD: u32 = DAY_IN_LEDGERS;
/// Minimum TTL for instance storage accepted by `set_ttl_config`.
const MIN_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS;

// ─── Missed contribution policy ───────────────────────────────────────────────
/// Default number of missed cycles tolerated before a member is suspended.
const DEFAULT_MAX_MISSED: u32 = 1;
/// Reinstatement penalty per missed cycle, in basis points of the
/// contribution amount (issue #446). 1000 bps = 10%.
const REINSTATEMENT_PENALTY_BPS: i128 = 1_000;
/// Lifetime of a pending multi-sig payout approval (issue #448).
const PAYOUT_APPROVAL_EXPIRY_SECS: u64 = 172_800; // 48 hours

// ─── Upgrade governance ───────────────────────────────────────────────────────
/// Minimum delay (seconds) between `propose_upgrade` and a matching `upgrade`
/// call taking effect. Gives circle members visibility/time to react (e.g.
/// exit) before new contract logic goes live, instead of an admin being able
/// to swap the WASM instantly and unilaterally.
const UPGRADE_TIMELOCK_SECS: u64 = 172_800; // 48 hours

/// How long a guardian `emergency_pause` lasts without multi-sig confirmation
/// via `pause` before it lapses automatically (issue #452).
pub const EMERGENCY_PAUSE_TTL_SECS: u64 = 86_400; // 24 hours

// ─── Interval bounds (issue #48) ──────────────────────────────────────────────
/// Minimum seconds between payouts (1 day, issue #451). A shorter cycle would
/// let payouts fire every few seconds and drain the pot faster than members
/// can react, so `initialize` rejects anything below this with
/// `Error::InvalidCycleInterval`.
pub const MIN_REALISTIC_CYCLE_INTERVAL_SECS: u64 = 86_400;
/// Maximum seconds between payouts (365 days). Bounds `timestamp + interval`
/// far below `u64::MAX` so payout scheduling can never overflow.
pub const MAX_CYCLE_INTERVAL_SECS: u64 = 365 * 24 * 60 * 60;

// ─── Errors ───────────────────────────────────────────────────────────────────

/// Typed contract errors.
///
/// Using `contracterror` lets callers distinguish error conditions via the
/// Soroban RPC status code rather than parsing panic strings.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The token used in `contribute` or `join` does not match the issuer
    /// (admin) address stored at initialisation.  This prevents a malicious
    /// actor from substituting a look-alike token contract.
    InvalidTokenIssuer = 1,
    /// State-changing circle operations are disabled while the admin pause is active.
    CirclePaused = 2,
    /// `cycle_interval_secs` is below `MIN_REALISTIC_CYCLE_INTERVAL_SECS` or
    /// above `MAX_CYCLE_INTERVAL_SECS`.
    InvalidCycleInterval = 3,
    /// `pause` was not approved by enough multi-sig pause signers.
    InsufficientApprovals = 4,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

/// Storage key classification for optimization:
/// - Instance: Core configuration (admin, token, amounts, members list, payout order)
///   Survives entire contract lifetime, extended via TTL bumping
/// - Temporary: Per-cycle contribution tracking, cleared on circle completion
///   Lower ledger fees as they expire automatically after TTL
/// - Persistent: Member reputation (cross-contract lifetime data)
#[contracttype]
pub enum DataKey {
    // ─── Instance storage (core circle configuration) ────────────────────────────
    Admin,
    PendingAdmin,
    PendingUpgradeHash,
    PendingUpgradeTime,
    Token,
    /// Expected issuer (admin) of the USDC token contract stored at init (issue #245).
    ExpectedIssuer,
    ContributionAmount,
    MaxMembers,
    CycleIntervalSecs,
    Members,
    PayoutOrder,
    CurrentCycle,
    NextPayoutTime,
    Completed,
    Paused,
    /// Expiry timestamp of an unconfirmed guardian emergency pause (issue #452).
    PauseExpiresAt,
    /// M-of-N signers allowed to approve `pause` (defaults to `[admin]`).
    PauseSigners,
    /// Number of `PauseSigners` approvals `pause` requires (defaults to 1).
    PauseThreshold,
    /// Single key allowed to call `emergency_pause`.
    Guardian,
    StorageVersion,
    TtlThreshold,
    TtlExtendTo,

    // ─── Temporary storage (per-cycle, cleared after completion) ─────────────────
    Contributions(Address, u32), // (member, cycle) → bool

    // ─── Persistent storage (member reputation, survives upgrades) ────────────────
    MemberReputation(Address),
    TotalCirclesCompleted(Address),
    OnTimeContributions(Address),
    TotalContributions(Address),

    // ─── Reentrancy guard (issue #264) - instance storage ────────────────────────
    PayoutLock,

    // ─── Missed contribution policy (issue #50) ──────────────────────────────────
    MaxMissedContributions,          // instance: allowed misses before suspension
    MissedContributions(Address),    // persistent (legacy v1): lifetime missed count
    Suspended(Address),              // instance (legacy v1): member suspended flag

    // ─── Packed per-member state (storage v2, issue #254; v3, issue #447) ────────
    MemberStats(Address),            // persistent: all per-member state in one entry

    // ─── Multi-sig payout policy (issue #448) - instance storage ────────────────
    PayoutThreshold,                 // i128: pots above this need M-of-N approval
    PayoutSigners,                   // Vec<Address>: N approvers
    PayoutRequiredSigs,              // u32: M
    PayoutApproval(u32),             // cycle → PendingPayoutApproval
}

/// Pending M-of-N approval for a large payout (issue #448).
#[contracttype]
#[derive(Clone)]
pub struct PendingPayoutApproval {
    pub approvers: Vec<Address>,
    pub expires_at: u64,
}

/// Storage v2 layout of `MemberStats`, kept only so `migrate()` can decode
/// existing entries when upgrading to v3.
#[contracttype]
#[derive(Clone)]
pub struct MemberStatsV2 {
    pub reputation: u32,
    pub circles_completed: u32,
    pub on_time_contributions: u32,
    pub total_contributions: u32,
    pub missed_contributions: u32,
    pub suspended: bool,
}

/// Packed per-member persistent state (storage v2, issue #254).
///
/// Replaces five separate per-member ledger entries (`MemberReputation`,
/// `TotalCirclesCompleted`, `OnTimeContributions`, `TotalContributions`,
/// `MissedContributions`) and the per-member instance `Suspended` flag with
/// a single persistent entry per member: 5 ledger entries → 1, and the
/// instance entry no longer grows with suspension flags. Same values, same
/// public API as storage v1.
/// Snapshot of circle state for off-chain indexers (see `get_circle_state`).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CircleState {
    /// One of `forming`, `active`, `paused`, `completed`.
    pub status: Symbol,
    pub current_cycle: u32,
    pub total_members: u32,
    pub joined_members: u32,
    pub next_payout_at: u64,
    pub admin: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct MemberStats {
    pub reputation: u32,
    pub circles_completed: u32,
    pub on_time_contributions: u32,
    pub total_contributions: u32,
    pub missed_contributions: u32,
    pub suspended: bool,
    /// Last cycle the member paid for (storage v3, issue #447). Replaces the
    /// temporary-storage read used as the duplicate-contribution guard.
    pub last_cycle: u32,
    /// Missed cycles not yet paid back via `reinstate_member` (issue #446).
    pub unpaid_missed: u32,
}

impl MemberStats {
    fn zeroed() -> Self {
        MemberStats {
            reputation: 0,
            circles_completed: 0,
            on_time_contributions: 0,
            total_contributions: 0,
            missed_contributions: 0,
            suspended: false,
            last_cycle: 0,
            unpaid_missed: 0,
        }
    }
}

/// Typed per-member view returned by `get_member_state` (issue #465).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemberState {
    pub joined: bool,
    pub contributions_paid: u32,
    pub payout_received: bool,
    pub suspended: bool,
    pub missed_cycles: u32,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct AjoContract;

#[contractimpl]
impl AjoContract {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialize the circle.
    ///
    /// * `admin`               – address that controls admin operations
    /// * `token`               – USDC token contract address
    /// * `expected_issuer`     – expected issuer (admin) of the USDC token contract;
    ///                           used by `contribute` to reject look-alike tokens (issue #245)
    /// * `contribution_amount` – USDC amount per member per cycle (in stroops)
    /// * `max_members`         – total number of members (= total cycles)
    /// * `cycle_interval_secs` – seconds between payouts (e.g. 2592000 = 30 days)
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        expected_issuer: Address,
        contribution_amount: i128,
        max_members: u32,
        cycle_interval_secs: u64,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if max_members < 2 || max_members > 20 {
            panic!("max_members must be between 2 and 20");
        }
        if contribution_amount <= 0 {
            panic!("contribution_amount must be positive");
        }
        if cycle_interval_secs < MIN_REALISTIC_CYCLE_INTERVAL_SECS
            || cycle_interval_secs > MAX_CYCLE_INTERVAL_SECS
        {
            return Err(Error::InvalidCycleInterval);
        }
        // The full pot must be representable.
        if contribution_amount.checked_mul(max_members as i128).is_none() {
            panic!("contribution_amount too large");
        }

        // ─── Address validation (issue #47) ───────────────────────────────────
        let this = env.current_contract_address();
        if admin == token {
            panic!("admin and token must differ");
        }
        if admin == this {
            panic!("admin cannot be the contract itself");
        }
        if token == this {
            panic!("token cannot be the contract itself");
        }

        admin.require_auth();

        // ─── Token issuer safeguard ────────────────────────────────────────────
        // `token` is admin-supplied and, once set here, can never be changed for
        // the lifetime of this circle (there is no `set_token`/update path).
        // Probe it with a standard SEP-41 read before persisting any state, so a
        // bad or non-token address fails atomically in this same call instead of
        // silently bricking the circle the first time `join`/`contribute`/`payout`
        // tries to move funds through it.
        token::Client::new(&env, &token).decimals();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::ExpectedIssuer, &expected_issuer);
        env.storage().instance().set(&DataKey::ContributionAmount, &contribution_amount);
        env.storage().instance().set(&DataKey::MaxMembers, &max_members);
        env.storage().instance().set(&DataKey::CycleIntervalSecs, &cycle_interval_secs);
        env.storage().instance().set(&DataKey::Members, &Vec::<Address>::new(&env));
        env.storage().instance().set(&DataKey::PayoutOrder, &Vec::<u32>::new(&env));
        env.storage().instance().set(&DataKey::CurrentCycle, &0u32);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Completed, &false);

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (admin, max_members, contribution_amount),
        );
        Ok(())
    }

    // ── Member operations ─────────────────────────────────────────────────────

    /// Join the circle. Transfers the first contribution into the contract.
    pub fn join(env: Env, member: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        if Self::is_paused(&env) {
            return Err(Error::CirclePaused);
        }
        member.require_auth();

        let max_members: u32 = env.storage().instance().get(&DataKey::MaxMembers).expect("not initialized");
        let mut members: Vec<Address> = env.storage().instance().get(&DataKey::Members).expect("not initialized");
        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");

        if current_cycle > 0 {
            panic!("circle already started");
        }
        if members.len() >= max_members {
            panic!("circle is full");
        }
        if members.contains(&member) {
            panic!("already a member");
        }

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("not initialized");
        let amount: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&member, &env.current_contract_address(), &amount);

        // Use temporary storage for contribution tracking (lower ledger fees)
        Self::set_temp_contribution(&env, &member, 1, true);
        let mut stats = Self::member_stats(&env, &member);
        stats.last_cycle = 1;
        Self::store_member_stats(&env, &member, &stats);

        members.push_back(member.clone());
        env.storage().instance().set(&DataKey::Members, &members);

        if members.len() == max_members {
            let interval: u64 = env.storage().instance().get(&DataKey::CycleIntervalSecs).expect("not initialized");
            let next_payout = Self::schedule_after(&env, interval);
            env.storage().instance().set(&DataKey::CurrentCycle, &1u32);
            env.storage().instance().set(&DataKey::NextPayoutTime, &next_payout);
            env.events().publish((Symbol::new(&env, "circle_started"),), (max_members, amount));
        }

        env.events().publish(
            (Symbol::new(&env, "member_joined"),),
            (member, amount),
        );
        Ok(())
    }

    /// Contribute for the current cycle.
    ///
    /// The caller must pass the exact `ContributionAmount`; the contract
    /// rejects any other value to prevent under- and over-contributions.
    pub fn contribute(env: Env, member: Address, amount: i128) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);

        // Respect emergency pause
        let paused: bool = Self::is_paused(&env);
        if paused {
            return Err(Error::CirclePaused);
        }
        member.require_auth();

        let required: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");
        if amount != required {
            panic!("contribution amount must equal required amount");
        }

        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");
        if current_cycle == 0 {
            panic!("circle not started yet");
        }

        let members: Vec<Address> = env.storage().instance().get(&DataKey::Members).expect("not initialized");
        if !members.contains(&member) {
            panic!("not a member");
        }
        // Packed per-member record (issue #447): one read covers the
        // suspension flag and the duplicate-contribution guard.
        let mut stats = Self::member_stats(&env, &member);
        if stats.suspended {
            panic!("member is suspended");
        }
        if stats.last_cycle == current_cycle {
            panic!("already contributed this cycle");
        }

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("not initialized");

        // ── Issue #245: validate token issuer ────────────────────────────────
        // Compare the token contract's current admin (issuer) against the
        // expected_issuer stored at initialisation.  A look-alike token deployed
        // by a malicious actor will have a different admin and will be rejected.
        let expected_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::ExpectedIssuer)
            .expect("not initialized");
        let actual_issuer = token::StellarAssetClient::new(&env, &token).admin();
        if actual_issuer != expected_issuer {
            panic!("InvalidTokenIssuer");
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&member, &env.current_contract_address(), &amount);

        let next_payout_time: u64 = env.storage().instance().get(&DataKey::NextPayoutTime).expect("not initialized");
        let is_on_time = env.ledger().timestamp() < next_payout_time;

        // Single packed write (issue #447): counters, last_cycle and
        // reputation are updated together.
        if is_on_time {
            stats.on_time_contributions += 1;
        }
        stats.total_contributions += 1;
        stats.last_cycle = current_cycle;
        stats.reputation = Self::compute_reputation(&stats);
        Self::store_member_stats(&env, &member, &stats);

        env.events().publish(
            (Symbol::new(&env, "reputation_updated"),),
            (member.clone(), stats.reputation),
        );

        // Issue #444: the contract must always hold at least the funds owed.
        #[cfg(debug_assertions)]
        assert!(Self::check_invariants(env.clone()).2 >= 0, "invariant violated: locked funds shortfall");

        env.events().publish(
            (Symbol::new(&env, "contribution_made"),),
            (member, amount, current_cycle),
        );
        Ok(())
    }

    // ── Admin operations ──────────────────────────────────────────────────────

    /// Set payout order. Admin-only.
    pub fn set_payout_order(env: Env, order: Vec<u32>) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");
        if current_cycle > 0 {
            panic!("cannot set payout order after circle starts");
        }

        let max_members: u32 = env.storage().instance().get(&DataKey::MaxMembers).expect("not initialized");
        if order.len() != max_members {
            panic!("payout order length must equal max_members");
        }

        // ─── Permutation validation (issue #49) ───────────────────────────────
        // Every index in 0..max_members must appear exactly once so each member
        // is paid exactly once and no payout references a missing member.
        let mut seen: u32 = 0; // bitmask; max_members <= 20
        for idx in order.iter() {
            if idx >= max_members {
                panic!("payout order index out of range");
            }
            let bit = 1u32 << idx;
            if seen & bit != 0 {
                panic!("payout order contains duplicate index");
            }
            seen |= bit;
        }

        env.storage().instance().set(&DataKey::PayoutOrder, &order);
        env.events().publish((Symbol::new(&env, "PayoutOrderSet"),), (order,));
    }

    /// Trigger payout to the current cycle's recipient. Admin-only, callable after next_payout_time.
    ///
    /// # Security – Reentrancy Guard (issue #264)
    /// A `PayoutLock` flag is set at the start and cleared at the end.
    /// The contract follows checks-effects-interactions: all state mutations
    /// occur before the external token transfer.
    pub fn payout(env: Env) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);

        // Respect emergency pause
        let paused: bool = Self::is_paused(&env);
        if paused {
            return Err(Error::CirclePaused);
        }

        // ─── Reentrancy guard ─────────────────────────────────────────────────
        let locked: bool = env.storage().instance().get(&DataKey::PayoutLock).unwrap_or(false);
        if locked {
            panic!("payout already in progress");
        }
        env.storage().instance().set(&DataKey::PayoutLock, &true);

        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let completed: bool = env.storage().instance().get(&DataKey::Completed).unwrap_or(false);
        if completed {
            panic!("circle already completed");
        }

        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");
        if current_cycle == 0 {
            panic!("circle not started");
        }

        let next_payout_time: u64 = env.storage().instance().get(&DataKey::NextPayoutTime).expect("not initialized");
        if env.ledger().timestamp() < next_payout_time {
            panic!("payout time not reached");
        }

        let members: Vec<Address> = env.storage().instance().get(&DataKey::Members).expect("not initialized");
        let max_members: u32 = env.storage().instance().get(&DataKey::MaxMembers).expect("not initialized");

        for m in members.iter() {
            // Packed per-member record (issue #447) is the contribution flag.
            let paid: bool = Self::member_stats(&env, &m).last_cycle == current_cycle;
            if !paid {
                env.events().publish((Symbol::new(&env, "member_defaulted"),), (m.clone(), current_cycle));
                Self::record_missed_contribution(&env, &m, current_cycle);
            }
        }

        // Determine recipient from payout order (default: join order)
        let payout_order: Vec<u32> = {
            let stored: Vec<u32> = env
                .storage()
                .instance()
                .get(&DataKey::PayoutOrder)
                .unwrap_or(Vec::new(&env));
            if stored.is_empty() {
                let mut default_order = Vec::new(&env);
                for i in 0..max_members {
                    default_order.push_back(i);
                }
                default_order
            } else {
                stored
            }
        };

        let recipient_idx = payout_order.get(current_cycle - 1).expect("invalid cycle");
        let recipient = members.get(recipient_idx).expect("invalid member index");

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("not initialized");
        let contribution: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");
        let pot = contribution
            .checked_mul(max_members as i128)
            .expect("pot overflow");
        Self::enforce_payout_multisig(&env, current_cycle, pot);

        // ─── Effects before external call ─────────────────────────────────────
        if current_cycle >= max_members {
            env.storage().instance().set(&DataKey::Completed, &true);
            // Clear temporary contribution entries to reduce ledger footprint
            Self::clear_temp_contributions(&env, &members, max_members);
            for member in members.iter() {
                let mut stats = Self::member_stats(&env, &member);
                stats.circles_completed += 1;
                Self::store_member_stats(&env, &member, &stats);
                Self::update_reputation(&env, &member);
            }
        } else {
            let interval: u64 = env.storage().instance().get(&DataKey::CycleIntervalSecs).expect("not initialized");
            env.storage().instance().set(&DataKey::CurrentCycle, &(current_cycle + 1));
            env.storage().instance().set(&DataKey::NextPayoutTime, &Self::schedule_after(&env, interval));
        }

        // ─── Interaction ──────────────────────────────────────────────────────
        let token_client = token::Client::new(&env, &token);
        let balance_before = token_client.balance(&recipient);
        token_client.transfer(&env.current_contract_address(), &recipient, &pot);
        if token_client.balance(&recipient) - balance_before != pot {
            return Err(Error::PayoutAmountMismatch);
        }

        env.storage().instance().set(&DataKey::PayoutLock, &false);

        // Issue #444: the contract must always hold at least the funds owed.
        #[cfg(debug_assertions)]
        assert!(Self::check_invariants(env.clone()).2 >= 0, "invariant violated: locked funds shortfall");

        env.events().publish(
            (Symbol::new(&env, "payout_sent"),),
            (recipient.clone(), pot, current_cycle)
        );
        if current_cycle >= max_members {
            Self::mint_certificates(&env, &members, max_members, pot);
            env.events().publish((Symbol::new(&env, "circle_completed"),), ());
        }
        Ok(())
    }

    /// Configure the certificate contract and circle id used to mint soul-bound
    /// completion certificates for every member when the circle completes. Admin-only.
    /// This contract must also be registered via `add_minter` on the certificate contract.
    pub fn set_certificate_config(env: Env, certificate_contract: Address, circle_id: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::CertificateContract, &certificate_contract);
        env.storage().instance().set(&DataKey::CircleId, &circle_id);
    }

    /// Internal: Calculate and update reputation score for a member
    /// Score is based on:
    /// - On-time contribution rate (70% weight)
    /// - Number of completed circles (30% weight)
    fn update_reputation(env: &Env, member: &Address) {
        let mut updated = Self::member_stats(env, member);
        let reputation = Self::compute_reputation(&updated);

        // Update the packed per-member entry and extend its TTL.
        updated.reputation = reputation;
        Self::store_member_stats(env, member, &updated);

        env.events().publish(
            (Symbol::new(&env, "reputation_updated"),),
            (member.clone(), reputation),
        );
    }

    /// Pure reputation score (0-100) from packed member stats.
    fn compute_reputation(stats: &MemberStats) -> u32 {
        let on_time: u32 = stats.on_time_contributions;
        let total: u32 = if stats.total_contributions > 0 {
            stats.total_contributions
        } else {
            1 // avoid division by zero
        };
        let circles_completed: u32 = stats.circles_completed;

        // On-time rate: 0-70 points
        let on_time_score = if total > 0 {
            (on_time * 70) / total
        } else {
            0
        };

        // Completed circles: 0-30 points (capped at 10 circles)
        let circles_score = if circles_completed >= 10 {
            30
        } else {
            circles_completed * 3
        };

        on_time_score + circles_score
    }

    /// Read-only: get reputation score for a member (0-100)
    pub fn get_reputation(env: Env, member: Address) -> u32 {
        Self::extend_instance_ttl(&env);
        Self::member_stats(&env, &member).reputation
    }

    /// Read-only: get detailed reputation stats for a member
    pub fn get_reputation_stats(env: Env, member: Address) -> (u32, u32, u32, u32) {
        Self::extend_instance_ttl(&env);
        let stats = Self::member_stats(&env, &member);
        (
            stats.reputation,
            stats.circles_completed,
            stats.on_time_contributions,
            stats.total_contributions,
        )
    }

    /// Migrate storage layout after a contract upgrade. Admin-only.
    ///
    /// Call once immediately after `upgrade()` when the new WASM introduces
    /// storage layout changes. No-op if already at `STORAGE_VERSION`.
    ///
    /// Idempotent and resumable (issue #457): each step is gated on the stored
    /// `StorageVersion` and records its own version as soon as it finishes,
    /// so a re-run skips steps that already completed. `migrate` makes no
    /// cross-contract calls, so it cannot be re-entered.
    ///
    /// To add a future migration: bump `STORAGE_VERSION` and add an
    /// `if from < N { … }` block below that ends by storing `N`.
    /// See `contracts/ajo/STORAGE_LAYOUT.md`.
    pub fn migrate(env: Env) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let from: u32 = env
            .storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(0);

        if from >= STORAGE_VERSION {
            return;
        }

        // ── v0 → v1 ──────────────────────────────────────────────────────────
        // Ensure PayoutLock is initialised on contracts upgraded from v0.
        if from < 1 {
            if !env.storage().instance().has(&DataKey::PayoutLock) {
                env.storage().instance().set(&DataKey::PayoutLock, &false);
            }
            env.storage().instance().set(&DataKey::StorageVersion, &1u32);
        }

        // ── v1 → v2 (issue #254) ──────────────────────────────────────────────
        // Pack the five per-member persistent entries and the instance
        // `Suspended` flag into one `MemberStats` entry per member. Idempotent:
        // members that already have a packed entry are skipped.
        if from < 2 {
            let members: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Members)
                .unwrap_or(Vec::new(&env));
            for member in members.iter() {
                if env.storage().persistent().has(&DataKey::MemberStats(member.clone())) {
                    continue;
                }

                let reputation: Option<u32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::MemberReputation(member.clone()));
                let circles_completed: Option<u32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::TotalCirclesCompleted(member.clone()));
                let on_time_contributions: Option<u32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::OnTimeContributions(member.clone()));
                let total_contributions: Option<u32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::TotalContributions(member.clone()));
                let missed_contributions: Option<u32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::MissedContributions(member.clone()));
                let suspended: bool = env
                    .storage()
                    .instance()
                    .get(&DataKey::Suspended(member.clone()))
                    .unwrap_or(false);

                let has_legacy = reputation.is_some()
                    || circles_completed.is_some()
                    || on_time_contributions.is_some()
                    || total_contributions.is_some()
                    || missed_contributions.is_some()
                    || suspended;

                if has_legacy {
                    let stats = MemberStats {
                        reputation: reputation.unwrap_or(0),
                        circles_completed: circles_completed.unwrap_or(0),
                        on_time_contributions: on_time_contributions.unwrap_or(0),
                        total_contributions: total_contributions.unwrap_or(0),
                        missed_contributions: missed_contributions.unwrap_or(0),
                        suspended,
                        last_cycle: 0,
                        unpaid_missed: 0,
                    };
                    Self::store_member_stats(&env, &member, &stats);
                }

                let legacy: [DataKey; 5] = [
                    DataKey::MemberReputation(member.clone()),
                    DataKey::TotalCirclesCompleted(member.clone()),
                    DataKey::OnTimeContributions(member.clone()),
                    DataKey::TotalContributions(member.clone()),
                    DataKey::MissedContributions(member.clone()),
                ];
                for key in legacy.iter() {
                    if env.storage().persistent().has(key) {
                        env.storage().persistent().remove(key);
                    }
                }
                if env.storage().instance().has(&DataKey::Suspended(member.clone())) {
                    env.storage().instance().remove(&DataKey::Suspended(member.clone()));
                }
            }
            env.storage().instance().set(&DataKey::StorageVersion, &2u32);
        }

        // ── v2 → v3 (issue #447) ──────────────────────────────────────────────
        // Add `last_cycle` / `unpaid_missed` to each packed `MemberStats`.
        // Entries written by the v1 → v2 block above already use v3 layout.
        if from == 2 {
            let members: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Members)
                .unwrap_or(Vec::new(&env));
            let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).unwrap_or(0);
            for member in members.iter() {
                let key = DataKey::MemberStats(member.clone());
                let old: Option<MemberStatsV2> = env.storage().persistent().get(&key);
                if let Some(old) = old {
                    let last_cycle = if current_cycle > 0
                        && Self::get_temp_contribution(&env, &member, current_cycle)
                    {
                        current_cycle
                    } else {
                        0
                    };
                    let stats = MemberStats {
                        reputation: old.reputation,
                        circles_completed: old.circles_completed,
                        on_time_contributions: old.on_time_contributions,
                        total_contributions: old.total_contributions,
                        missed_contributions: old.missed_contributions,
                        suspended: old.suspended,
                        last_cycle,
                        unpaid_missed: 0,
                    };
                    Self::store_member_stats(&env, &member, &stats);
                }
            }
        }

        // ── Add future migration blocks here ─────────────────────────────────
        // if from < 4 { … }

        env.storage().instance().set(&DataKey::StorageVersion, &STORAGE_VERSION);

        env.events().publish((Symbol::new(&env, "migrated"),), (from, STORAGE_VERSION));
    }

    /// Propose an upgrade to `new_wasm_hash`. Admin-only.
    ///
    /// Starts the upgrade-governance timelock: the matching `upgrade` call
    /// cannot execute until `UPGRADE_TIMELOCK_SECS` has elapsed. Proposing a
    /// new hash replaces any previous pending proposal.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        // Traps if no code entry exists for this hash (WASM not uploaded).
        env.deployer().extend_ttl_for_code(
            new_wasm_hash.clone(),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let effective_at = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        env.storage().instance().set(&DataKey::PendingUpgradeHash, &new_wasm_hash);
        env.storage().instance().set(&DataKey::PendingUpgradeTime, &effective_at);

        env.events().publish(
            (Symbol::new(&env, "upgrade_proposed"),),
            (new_wasm_hash, effective_at),
        );
        Ok(())
    }

    /// Cancel a pending upgrade proposal. Admin-only. No-op if none pending.
    pub fn cancel_upgrade(env: Env) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        env.storage().instance().remove(&DataKey::PendingUpgradeHash);
        env.storage().instance().remove(&DataKey::PendingUpgradeTime);

        env.events().publish((Symbol::new(&env, "upgrade_cancelled"),), ());
    }

    /// Execute a previously proposed upgrade to `new_wasm_hash`. Admin-only.
    ///
    /// Requires a matching `propose_upgrade` call whose timelock
    /// (`UPGRADE_TIMELOCK_SECS`) has elapsed. This is the upgrade-governance
    /// boundary for #55: an admin can no longer swap the contract WASM in a
    /// single, immediate call.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let pending_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgradeHash)
            .expect("no pending upgrade proposed");
        if pending_hash != new_wasm_hash {
            panic!("new_wasm_hash does not match the pending upgrade proposal");
        }

        let effective_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgradeTime)
            .expect("no pending upgrade proposed");
        if env.ledger().timestamp() < effective_at {
            panic!("upgrade timelock has not elapsed");
        }

        env.storage().instance().remove(&DataKey::PendingUpgradeHash);
        env.storage().instance().remove(&DataKey::PendingUpgradeTime);

        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish((Symbol::new(&env, "upgraded"),), (new_wasm_hash,));
    }

    /// Configure the M-of-N multi-sig that must approve `pause`. Admin-only.
    /// Until configured, the signer set is `[admin]` with a threshold of 1.
    pub fn set_pause_signers(env: Env, signers: Vec<Address>, threshold: u32) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();
        if threshold == 0 || threshold > signers.len() {
            panic!("threshold must be between 1 and the number of signers");
        }
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                if signers.get_unchecked(i) == signers.get_unchecked(j) {
                    panic!("duplicate pause signer");
                }
            }
        }
        env.storage().instance().set(&DataKey::PauseSigners, &signers);
        env.storage().instance().set(&DataKey::PauseThreshold, &threshold);
        env.events().publish((Symbol::new(&env, "PauseSignersUpdated"),), (signers, threshold));
    }

    /// Designate the guardian key allowed to call `emergency_pause`. Admin-only.
    pub fn set_guardian(env: Env, guardian: Address) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.events().publish((Symbol::new(&env, "GuardianUpdated"),), (guardian,));
    }

    /// Pause the circle. Requires `PauseThreshold` distinct approvals from
    /// `PauseSigners` (issue #452). Calling this while a guardian emergency
    /// pause is active confirms it, removing its 24 h expiry.
    pub fn pause(env: Env, approvers: Vec<Address>) {
        let (signers, threshold) = Self::pause_signers(&env);
        let mut approved = Vec::<Address>::new(&env);
        for a in approvers.iter() {
            if !signers.contains(&a) {
                panic!("approver is not a pause signer");
            }
            if approved.contains(&a) {
                panic!("duplicate approver");
            }
            a.require_auth();
            approved.push_back(a);
        }
        if approved.len() < threshold {
            panic_with_error!(&env, Error::InsufficientApprovals);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().remove(&DataKey::PauseExpiresAt);
        env.events().publish((Symbol::new(&env, "paused"),), ());
        env.events().publish((Symbol::new(&env, "CirclePaused"),), (approved, 0u64));
    }

    /// Instant single-key pause by the guardian. Lapses automatically after
    /// `EMERGENCY_PAUSE_TTL_SECS` unless confirmed by a multi-sig `pause`.
    pub fn emergency_pause(env: Env) {
        let guardian: Address = env.storage().instance().get(&DataKey::Guardian).expect("guardian not set");
        guardian.require_auth();
        Self::require_not_paused(&env);
        let expires_at = env.ledger().timestamp() + EMERGENCY_PAUSE_TTL_SECS;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().set(&DataKey::PauseExpiresAt, &expires_at);
        env.events().publish((Symbol::new(&env, "paused"),), ());
        env.events().publish((Symbol::new(&env, "CirclePaused"),), (vec![&env, guardian], expires_at));
    }

    /// Lift the pause — admin-only.
    pub fn unpause(env: Env) {
        Self::extend_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().remove(&DataKey::PauseExpiresAt);
        env.events().publish((Symbol::new(&env, "CircleResumed"),), ());
        env.events().publish((Symbol::new(&env, "unpaused"),), ());
        env.events().publish((Symbol::new(&env, "CircleUnpaused"),), (admin,));
    }

    // ── Read-only ─────────────────────────────────────────────────────────────

    pub fn get_state(env: Env) -> (u32, u32, u64, bool, bool) {
        Self::extend_instance_ttl(&env);
        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).unwrap_or(0);
        let max_members: u32 = env.storage().instance().get(&DataKey::MaxMembers).unwrap_or(0);
        let next_payout_time: u64 = env.storage().instance().get(&DataKey::NextPayoutTime).unwrap_or(0);
        let completed: bool = env.storage().instance().get(&DataKey::Completed).unwrap_or(false);
        let paused: bool = Self::is_paused(&env);
        (current_cycle, max_members, next_payout_time, completed, paused)
    }

    /// Read-only invariant check (issue #444).
    ///
    /// Returns `(expected, actual, delta)` where `expected` is the sum of
    /// contributions locked for the current, not-yet-paid-out cycle,
    /// `actual` is the contract's token balance and `delta = actual - expected`.
    /// A negative delta means funds are missing and indicates a bug or exploit.
    pub fn check_invariants(env: Env) -> (i128, i128, i128) {
        let token: Address = env.storage().instance().get(&DataKey::Token).expect("not initialized");
        let actual = token::Client::new(&env, &token).balance(&env.current_contract_address());

        let completed: bool = env.storage().instance().get(&DataKey::Completed).unwrap_or(false);
        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).unwrap_or(0);
        let mut expected: i128 = 0;
        if !completed && current_cycle > 0 {
            let amount: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");
            let members: Vec<Address> = env.storage().instance().get(&DataKey::Members).unwrap_or(Vec::new(&env));
            for m in members.iter() {
                if Self::get_temp_contribution(&env, &m, current_cycle) {
                    expected = expected.checked_add(amount).expect("expected overflow");
                }
            }
        }
        (expected, actual, actual - expected)
    }

    pub fn get_members(env: Env) -> Vec<Address> {
        Self::extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Members).unwrap_or(vec![&env])
    }

    /// Returns the token (and therefore issuer) this circle is configured to
    /// use, so integrators can verify a deployed circle's asset before
    /// trusting it with funds instead of relying solely on client-side config.
    pub fn get_token(env: Env) -> Address {
        Self::extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Token).expect("not initialized")
    }

    pub fn get_payout_order(env: Env) -> Vec<u32> {
        Self::extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::PayoutOrder).unwrap_or(vec![&env])
    }

    /// Read-only: get contribution status for every member in a given cycle.
    ///
    /// Returns a `Vec` of `(Address, bool)` tuples — one per member — where
    /// `true` means the member has contributed for `cycle` and `false` means
    /// they have not yet (or defaulted).
    pub fn get_contribution_status(env: Env, cycle: u32) -> Vec<(Address, bool)> {
        Self::extend_instance_ttl(&env);
        let members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or(Vec::new(&env));

        let mut result: Vec<(Address, bool)> = Vec::new(&env);
        for member in members.iter() {
            // Packed record (issue #447) covers contributions since v3;
            // temporary storage still holds join-time and pre-v3 entries.
            let paid: bool = Self::member_stats(&env, &member).last_cycle == cycle
                || Self::get_temp_contribution(&env, &member, cycle);
            result.push_back((member, paid));
        }
        result
    }

    /// Propose a new admin. Only the current admin can call this.
    /// The proposed admin must call `accept_admin` to complete the transfer.
    pub fn propose_admin(env: Env, new_admin: Address) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();
        // Issue #443: admin rotation is frozen while an upgrade is pending so a
        // new admin cannot inherit/replace a proposal and sidestep the timelock.
        if env.storage().instance().has(&DataKey::PendingUpgradeHash) {
            panic!("admin change blocked while upgrade is pending");
        }
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        env.events().publish((Symbol::new(&env, "admin_proposed"),), (admin, new_admin));
    }

    /// Accept the admin role. Only the pending admin can call this.
    pub fn accept_admin(env: Env) {
        Self::require_not_paused(&env);
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin");
        pending.require_auth();
        // Issue #443: admin rotation is frozen while an upgrade is pending so a
        // new admin cannot inherit/replace a proposal and sidestep the timelock.
        if env.storage().instance().has(&DataKey::PendingUpgradeHash) {
            panic!("admin change blocked while upgrade is pending");
        }
        let old_admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((Symbol::new(&env, "admin_transferred"),), (old_admin, pending));
    }

    /// Set instance TTL configuration (issue #456). Admin-only; on mainnet the
    /// admin is the multisig account (see `docs/multisig-admin.md`), so
    /// `require_auth` enforces the M-of-N signer threshold.
    ///
    /// Both `threshold` and `extend_to` must be ≥ `MIN_TTL_EXTEND_TO`.
    pub fn set_ttl_config(env: Env, threshold: u32, extend_to: u32) {
        Self::require_not_paused(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        if extend_to < MIN_TTL_EXTEND_TO {
            panic!("extend_to below minimum ttl");
        }
        if threshold < MIN_TTL_EXTEND_TO || threshold > extend_to {
            panic!("threshold must be in MIN_TTL_EXTEND_TO..=extend_to");
        }
        let max_ttl = env.storage().max_ttl();
        if extend_to > max_ttl {
            panic!("extend_to exceeds max ttl");
        }

        env.storage().instance().set(&DataKey::TtlThreshold, &threshold);
        env.storage().instance().set(&DataKey::TtlExtendTo, &extend_to);
        env.events().publish(
            (Symbol::new(&env, "TtlConfigUpdated"),),
            (admin.clone(), threshold, extend_to),
        );
        env.events().publish(
            (Symbol::new(&env, "ttl_config_updated"),),
            (admin, threshold, extend_to),
        );
    }

    // ── Missed contribution policy (issue #50) ────────────────────────────────

    /// Set how many missed cycles a member may accumulate in this circle
    /// before being suspended. Admin-only. Must be between 1 and max_members.
    pub fn set_missed_policy(env: Env, max_missed: u32) {
        Self::require_not_paused(&env);
        Self::extend_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let max_members: u32 = env.storage().instance().get(&DataKey::MaxMembers).expect("not initialized");
        if max_missed == 0 || max_missed > max_members {
            panic!("max_missed must be between 1 and max_members");
        }
        env.storage().instance().set(&DataKey::MaxMissedContributions, &max_missed);
        env.events().publish((Symbol::new(&env, "missed_policy_updated"),), (admin, max_missed));
    }

    /// Current missed-contribution threshold.
    pub fn get_missed_policy(env: Env) -> u32 {
        Self::extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::MaxMissedContributions).unwrap_or(DEFAULT_MAX_MISSED)
    }

    /// Lifetime missed contributions for a member.
    pub fn get_missed_contributions(env: Env, member: Address) -> u32 {
        Self::extend_instance_ttl(&env);
        Self::member_stats(&env, &member).missed_contributions
    }

    /// Whether a member is suspended from contributing in this circle.
    pub fn is_suspended(env: Env, member: Address) -> bool {
        Self::extend_instance_ttl(&env);
        Self::member_stats(&env, &member).suspended
    }

    /// Reinstate a suspended member (issue #446). Requires admin and member
    /// auth; the member pays every unpaid missed contribution plus a penalty of
    /// `REINSTATEMENT_PENALTY_BPS` of the contribution per missed cycle.
    ///
    /// Emits `member_reinstated` with `(member, missed_cycles_paid, penalty_paid)`.
    pub fn reinstate_member(env: Env, member: Address) {
        Self::require_not_paused(&env);
        Self::extend_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let members: Vec<Address> = env.storage().instance().get(&DataKey::Members).expect("not initialized");
        if !members.contains(&member) {
            panic!("not a member");
        }
        let mut stats = Self::member_stats(&env, &member);
        if !stats.suspended {
            panic!("member is not suspended");
        }
        member.require_auth();

        let contribution: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");
        let missed_cycles_paid = stats.unpaid_missed;
        let missed_amount = contribution
            .checked_mul(missed_cycles_paid as i128)
            .expect("amount overflow");
        let penalty_paid = missed_amount
            .checked_mul(REINSTATEMENT_PENALTY_BPS)
            .expect("amount overflow")
            / 10_000;
        let total = missed_amount.checked_add(penalty_paid).expect("amount overflow");

        stats.suspended = false;
        stats.unpaid_missed = 0;
        Self::store_member_stats(&env, &member, &stats);

        if total > 0 {
            let token: Address = env.storage().instance().get(&DataKey::Token).expect("not initialized");
            token::Client::new(&env, &token).transfer(&member, &env.current_contract_address(), &total);
        }

        env.events().publish(
            (Symbol::new(&env, "member_reinstated"),),
            (member, missed_cycles_paid, penalty_paid),
        );
    }

    // ── Multi-sig payout policy (issue #448) ──────────────────────────────────

    /// Configure the multi-sig payout policy. Admin-only, and only during
    /// initialisation (before the circle starts). Payouts whose pot exceeds
    /// `payout_threshold` then require `required` of `signers` to call
    /// `approve_payout` within 48 hours before `payout` executes.
    pub fn configure_payout_multisig(
        env: Env,
        payout_threshold: i128,
        signers: Vec<Address>,
        required: u32,
    ) {
        Self::extend_instance_ttl(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let current_cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");
        if current_cycle > 0 {
            panic!("circle already started");
        }
        if payout_threshold <= 0 {
            panic!("payout_threshold must be positive");
        }
        if required == 0 || required > signers.len() {
            panic!("required must be in 1..=signers");
        }
        for (i, s) in signers.iter().enumerate() {
            if signers.first_index_of(&s) != Some(i as u32) {
                panic!("duplicate signer");
            }
        }

        env.storage().instance().set(&DataKey::PayoutThreshold, &payout_threshold);
        env.storage().instance().set(&DataKey::PayoutSigners, &signers);
        env.storage().instance().set(&DataKey::PayoutRequiredSigs, &required);
        env.events().publish(
            (Symbol::new(&env, "payout_multisig_configured"),),
            (payout_threshold, signers.len(), required),
        );
    }

    /// Approve the payout for the current cycle as one of the multi-sig
    /// signers. The pending approval expires 48 hours after the first signature.
    pub fn approve_payout(env: Env, signer: Address) {
        Self::extend_instance_ttl(&env);
        signer.require_auth();

        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::PayoutSigners)
            .expect("multisig not configured");
        if !signers.contains(&signer) {
            panic!("not a payout signer");
        }
        let cycle: u32 = env.storage().instance().get(&DataKey::CurrentCycle).expect("not initialized");
        if cycle == 0 {
            panic!("circle not started");
        }

        let key = DataKey::PayoutApproval(cycle);
        let now = env.ledger().timestamp();
        let mut pending: PendingPayoutApproval = match env.storage().instance().get::<_, PendingPayoutApproval>(&key) {
            Some(p) if p.expires_at > now => p,
            _ => PendingPayoutApproval {
                approvers: Vec::new(&env),
                expires_at: now.checked_add(PAYOUT_APPROVAL_EXPIRY_SECS).expect("expiry overflow"),
            },
        };
        if pending.approvers.contains(&signer) {
            panic!("already approved");
        }
        pending.approvers.push_back(signer.clone());
        env.storage().instance().set(&key, &pending);
        env.events().publish(
            (Symbol::new(&env, "payout_approved"),),
            (signer, cycle, pending.approvers.len()),
        );
    }

    /// Pending approval for a cycle's payout, if any: `(approvals, expires_at)`.
    pub fn get_payout_approval(env: Env, cycle: u32) -> Option<(u32, u64)> {
        Self::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get::<_, PendingPayoutApproval>(&DataKey::PayoutApproval(cycle))
            .map(|p| (p.approvers.len(), p.expires_at))
    }

    /// Panics unless a pot above the configured threshold has M-of-N
    /// unexpired approvals for `cycle`. Consumes the approval on success.
    fn enforce_payout_multisig(env: &Env, cycle: u32, pot: i128) {
        let threshold: Option<i128> = env.storage().instance().get(&DataKey::PayoutThreshold);
        if !matches!(threshold, Some(t) if pot > t) {
            return;
        }
        let required: u32 = env.storage().instance().get(&DataKey::PayoutRequiredSigs).expect("multisig not configured");
        let key = DataKey::PayoutApproval(cycle);
        let pending: Option<PendingPayoutApproval> = env.storage().instance().get(&key);
        match pending {
            Some(p) if p.expires_at > env.ledger().timestamp() && p.approvers.len() >= required => {
                env.storage().instance().remove(&key);
            }
            _ => panic!("multisig approval required"),
        }
    }

    fn record_missed_contribution(env: &Env, member: &Address, cycle: u32) {
        let mut stats = Self::member_stats(env, member);
        let already_suspended = stats.suspended;
        stats.missed_contributions = stats.missed_contributions.saturating_add(1);
        stats.unpaid_missed = stats.unpaid_missed.saturating_add(1);
        // Missing a cycle counts against on-time reputation.
        stats.total_contributions = stats.total_contributions.saturating_add(1);
        let missed = stats.missed_contributions;
        Self::store_member_stats(env, member, &stats);

        Self::update_reputation(env, member);

        env.events().publish(
            (Symbol::new(env, "contribution_missed"),),
            (member.clone(), cycle, missed),
        );

        let max_missed: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxMissedContributions)
            .unwrap_or(DEFAULT_MAX_MISSED);
        if missed >= max_missed && !already_suspended {
            let mut updated = Self::member_stats(env, member);
            updated.suspended = true;
            Self::store_member_stats(env, member, &updated);
            env.events().publish((Symbol::new(env, "member_suspended"),), (member.clone(), missed));
        }
    }

    /// Mint a soul-bound certificate for each member via the certificate contract.
    /// No-op when no certificate contract is configured.
    fn mint_certificates(env: &Env, members: &Vec<Address>, cycles_completed: u32, payout_amount: i128) {
        let cert: Option<Address> = env.storage().instance().get(&DataKey::CertificateContract);
        let circle_id: Option<BytesN<32>> = env.storage().instance().get(&DataKey::CircleId);
        let (cert, circle_id) = match (cert, circle_id) {
            (Some(c), Some(id)) => (c, id),
            _ => return,
        };
        let contribution: i128 = env.storage().instance().get(&DataKey::ContributionAmount).expect("not initialized");
        let total_saved = contribution
            .checked_mul(cycles_completed as i128)
            .expect("total overflow");
        let minter = env.current_contract_address();
        for member in members.iter() {
            env.invoke_contract::<()>(
                &cert,
                &Symbol::new(env, "mint_from_circle"),
                vec![
                    env,
                    minter.into_val(env),
                    member.into_val(env),
                    circle_id.into_val(env),
                    cycles_completed.into_val(env),
                    total_saved.into_val(env),
                    payout_amount.into_val(env),
                ],
            );
        }
    }

    /// Set contribution status in temporary storage (expires when circle completes)
    /// This reduces ledger footprint compared to instance storage.
    /// Overflow-safe `now + interval` (issue #48).
    fn schedule_after(env: &Env, interval: u64) -> u64 {
        env.ledger()
            .timestamp()
            .checked_add(interval)
            .expect("next payout time overflow")
    }

    fn set_temp_contribution(env: &Env, member: &Address, cycle: u32, contributed: bool) {
        env.storage().temporary().set(&DataKey::Contributions(member.clone(), cycle), &contributed);
        Self::extend_temp_storage_ttl(env, member, cycle);
    }

    /// Get contribution status from temporary storage
    fn get_temp_contribution(env: &Env, member: &Address, cycle: u32) -> bool {
        env.storage().temporary().get(&DataKey::Contributions(member.clone(), cycle)).unwrap_or(false)
    }

    /// Clear all temporary contribution entries (call when circle completes)
    fn clear_temp_contributions(env: &Env, members: &Vec<Address>, max_members: u32) {
        for cycle in 1..=max_members {
            for member in members.iter() {
                env.storage().temporary().remove(&DataKey::Contributions(member.clone(), cycle));
            }
        }
    }

    fn extend_instance_ttl(env: &Env) {
        let threshold = env.storage().instance().get(&DataKey::TtlThreshold).unwrap_or(INSTANCE_LIFETIME_THRESHOLD);
        let extend_to = env.storage().instance().get(&DataKey::TtlExtendTo).unwrap_or(INSTANCE_BUMP_AMOUNT);

        env.storage()
            .instance()
            .extend_ttl(threshold, extend_to);
    }

    /// Extend TTL for a temporary contribution entry (issue #51).
    ///
    /// The entry must outlive the cycle it belongs to, otherwise it could
    /// expire before `payout` checks it and a paying member would be treated
    /// as defaulted. The TTL covers the cycle interval (converted to ledgers,
    /// ~5s each) plus a one-day buffer, capped at the network max TTL.
    fn extend_temp_storage_ttl(env: &Env, member: &Address, cycle: u32) {
        let temp_entry = DataKey::Contributions(member.clone(), cycle);
        let interval: u64 = env.storage().instance().get(&DataKey::CycleIntervalSecs).unwrap_or(0);
        let extend_to = Self::temp_ttl_for_interval(env, interval);
        env.storage().temporary().extend_ttl(&temp_entry, TEMP_LIFETIME_THRESHOLD.min(extend_to), extend_to);
    }

    fn temp_ttl_for_interval(env: &Env, interval_secs: u64) -> u32 {
        let ledgers = (interval_secs / 5).saturating_add(DAY_IN_LEDGERS as u64);
        let wanted = if ledgers > u32::MAX as u64 { u32::MAX } else { ledgers as u32 };
        wanted.max(7 * DAY_IN_LEDGERS).min(env.storage().max_ttl())
    }

    fn extend_persistent_ttl(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Read the packed per-member persistent record (storage v2, issue #254),
    /// defaulting to zeros for members with no record yet — the same values
    /// the v1 per-key `unwrap_or` defaults produced.
    fn member_stats(env: &Env, member: &Address) -> MemberStats {
        env.storage()
            .persistent()
            .get(&DataKey::MemberStats(member.clone()))
            .unwrap_or_else(MemberStats::zeroed)
    }

    /// Write the packed per-member record and extend its TTL.
    fn store_member_stats(env: &Env, member: &Address, stats: &MemberStats) {
        let key = DataKey::MemberStats(member.clone());
        env.storage().persistent().set(&key, stats);
        Self::extend_persistent_ttl(env, &key);
    }

    /// Whether the circle is paused. An unconfirmed guardian pause stops
    /// counting once its expiry has passed.
    fn is_paused(env: &Env) -> bool {
        if !env.storage().instance().get::<_, bool>(&DataKey::Paused).unwrap_or(false) {
            return false;
        }
        match env.storage().instance().get::<_, u64>(&DataKey::PauseExpiresAt) {
            Some(expires_at) => env.ledger().timestamp() < expires_at,
            None => true,
        }
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env) {
            panic_with_error!(env, Error::CirclePaused);
        }
    }

    fn pause_signers(env: &Env) -> (Vec<Address>, u32) {
        match env.storage().instance().get::<_, Vec<Address>>(&DataKey::PauseSigners) {
            Some(signers) => {
                let threshold: u32 = env.storage().instance().get(&DataKey::PauseThreshold).unwrap_or(1);
                (signers, threshold)
            }
            None => {
                let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
                (vec![env, admin], 1)
            }
        }
    }

    /// Test-only helper: force the payout lock to a given value.
    /// Used to simulate a re-entrant call in the Soroban sandbox.
    #[cfg(test)]
    pub fn set_payout_lock(env: Env, locked: bool) {
        env.storage().instance().set(&DataKey::PayoutLock, &locked);
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    fn setup(env: &Env) -> (Address, Vec<Address>, Address, TokenClient<'_>, AjoContractClient<'_>) {
        let admin = Address::generate(env);
        let members = vec![
            env,
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
        ];

        let token_id = env.register_stellar_asset_contract(admin.clone());
        let token = TokenClient::new(env, &token_id);
        let token_admin = StellarAssetClient::new(env, &token_id);

        for m in members.iter() {
            token_admin.mint(m, &1_000_000_000);
        }

        let contract_id = env.register_contract(None, AjoContract);
        let client = AjoContractClient::new(env, &contract_id);

        // admin is both the circle admin and the token issuer in tests
        client.initialize(&admin, &token_id, &admin, &100_000_000, &3, &86400);

        (admin, members, token_id, token, client)
    }

    #[test]
    fn test_contribution_storage_uses_temporary() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);

        for m in members.iter() { client.join(m); }

        // Check that contribution is stored in temporary storage
        let member = members.get(0).unwrap();
        let has_temp = env.storage().temporary().has(&DataKey::Contributions(member.clone(), 1));
        assert!(has_temp, "contribution should be in temporary storage after join");

        // Verify reading via get_contribution_status works
        let status = client.get_contribution_status(&1u32);
        let (_, paid) = status.get(0).unwrap();
        assert!(paid, "member should show as contributed for cycle 1");
    }

    #[test]
    fn test_full_cycle() {
        use soroban_sdk::{testutils::Events, TryFromVal};

        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, token, client) = setup(&env);

        for m in members.iter() { client.join(m); }

        let (cycle, max, _, completed, _) = client.get_state();
        assert_eq!(cycle, 1);
        assert_eq!(max, 3);
        assert!(!completed);

        // Verify circle_started event when last member joins
        let started_sym = Symbol::new(&env, "circle_started");
        let found_started = env.events().all().iter().any(|(_, topics, _)| {
            if topics.len() != 1 { return false; }
            let Ok(sym) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            sym == started_sym
        });
        assert!(found_started, "circle_started event should be emitted when circle fills");

        env.ledger().with_mut(|l| l.timestamp = 86401);
        client.payout();
        assert_eq!(token.balance(&members.get(0).unwrap()), 1_100_000_000);

        // Verify payout_sent event
        let payout_sym = Symbol::new(&env, "payout_sent");
        let found_payout = env.events().all().iter().any(|(_, topics, _)| {
            if topics.len() != 1 { return false; }
            let Ok(sym) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            sym == payout_sym
        });
        assert!(found_payout, "payout_sent event should be emitted");

        for m in members.iter() { client.contribute(m, &100_000_000); }
        env.ledger().with_mut(|l| l.timestamp = 172802);
        client.payout();

        for m in members.iter() { client.contribute(m, &100_000_000); }
        env.ledger().with_mut(|l| l.timestamp = 259203);
        client.payout();

        let (_, _, _, completed, _) = client.get_state();
        assert!(completed);

        // Verify circle_completed event on final payout
        let completed_sym = Symbol::new(&env, "circle_completed");
        let found_completed = env.events().all().iter().any(|(_, topics, _)| {
            if topics.len() != 1 { return false; }
            let Ok(sym) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            sym == completed_sym
        });
        assert!(found_completed, "circle_completed event should be emitted on final payout");

        // Verify temporary contributions are cleared after completion
        let has_temp = env.storage().temporary().has(&DataKey::Contributions(members.get(0).unwrap().clone(), 1));
        assert!(!has_temp, "temporary contributions should be cleared after circle completes");
    }

    #[test]
    #[should_panic(expected = "already contributed this cycle")]
    fn test_double_contribute_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);
        for m in members.iter() { client.join(m); }
        client.contribute(&members.get(0).unwrap(), &100_000_000);
    }

    #[test]
    fn test_defaulted_event() {
        use soroban_sdk::{testutils::Events, TryFromVal};

        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);

        for m in members.iter() { client.join(m); }

        env.ledger().with_mut(|l| l.timestamp = 86401);
        client.payout();

        // members[0] and members[1] contribute for cycle 2; members[2] defaults
        client.contribute(&members.get(0).unwrap(), &100_000_000);
        client.contribute(&members.get(1).unwrap(), &100_000_000);

        env.ledger().with_mut(|l| l.timestamp = 172802);
        client.payout();

        let defaulter = members.get(2).unwrap();
        let defaulted_sym = Symbol::new(&env, "member_defaulted");

        let found = env.events().all().iter().any(|(_, topics, data)| {
            if topics.len() != 1 { return false; }
            let Ok(sym) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            if sym != defaulted_sym { return false; }
            let Ok((addr, cycle)) = <(Address, u32)>::try_from_val(&env, data) else { return false; };
            addr == defaulter && cycle == 2
        });

        assert!(found, "no 'member_defaulted' event emitted for members[2] on cycle 2");
    }

    #[test]
    fn test_ttl_extension() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);

        client.set_ttl_config(&10, &100);
        client.join(&members.get(0).unwrap());
        env.ledger().with_mut(|l| l.sequence = 50);

        let (cycle, _, _, _, _) = client.get_state();
        assert_eq!(cycle, 0);
    }

    #[test]
    fn test_get_contribution_status() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);

        for m in members.iter() { client.join(m); }

        let status = client.get_contribution_status(&1u32);
        assert_eq!(status.len(), 3);
        for (_, paid) in status.iter() { assert!(paid); }

        env.ledger().with_mut(|l| l.timestamp = 86401);
        client.payout();

        let status2 = client.get_contribution_status(&2u32);
        for (_, paid) in status2.iter() { assert!(!paid); }

        client.contribute(&members.get(0).unwrap(), &100_000_000);
        let status3 = client.get_contribution_status(&2u32);
        let (_, m0_paid) = status3.get(0).unwrap();
        let (_, m1_paid) = status3.get(1).unwrap();
        assert!(m0_paid);
        assert!(!m1_paid);
    }

    #[test]
    fn test_payout_state_advancement() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);

        for m in members.iter() { client.join(m); }
        env.ledger().with_mut(|l| l.timestamp = 86401);

        let (cycle, _, _, completed, _) = client.get_state();
        assert_eq!(cycle, 1);
        assert!(!completed);

        client.payout();

        let (cycle, _, _, completed, _) = client.get_state();
        assert_eq!(cycle, 2);
        assert!(!completed);
    }

    #[test]
    fn test_propose_and_accept_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, _, client) = setup(&env);
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.accept_admin();
    }

    #[test]
    #[should_panic(expected = "no pending admin")]
    fn test_accept_admin_without_proposal_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, _, client) = setup(&env);
        client.accept_admin();
    }

    // ─── Event schema compatibility (issue #59) ──────────────────────────────
    //
    // Off-chain consumers (e.g. src/server/services/event-indexer.service.ts)
    // decode published events positionally by topic. These tests lock the
    // exact topic name + tuple shape of the events that feed that indexer,
    // so a future change that reorders or retypes a field is caught here
    // instead of silently breaking off-chain consumers.

    #[test]
    fn test_initialized_event_schema() {
        use soroban_sdk::{testutils::Events, TryFromVal};

        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _, _, _) = setup(&env);

        let sym = Symbol::new(&env, "initialized");
        let found = env.events().all().iter().any(|(_, topics, data)| {
            if topics.len() != 1 { return false; }
            let Ok(t) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            if t != sym { return false; }
            let Ok((a, max_members, amount)) = <(Address, u32, i128)>::try_from_val(&env, data) else { return false; };
            a == admin && max_members == 3 && amount == 100_000_000
        });
        assert!(
            found,
            "'initialized' event schema changed: expected (admin: Address, max_members: u32, contribution_amount: i128)"
        );
    }

    #[test]
    fn test_member_joined_event_schema() {
        use soroban_sdk::{testutils::Events, TryFromVal};

        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);
        let member = members.get(0).unwrap();
        client.join(&member);

        let sym = Symbol::new(&env, "member_joined");
        let found = env.events().all().iter().any(|(_, topics, data)| {
            if topics.len() != 1 { return false; }
            let Ok(t) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            if t != sym { return false; }
            let Ok((m, amount)) = <(Address, i128)>::try_from_val(&env, data) else { return false; };
            m == member && amount == 100_000_000
        });
        assert!(
            found,
            "'member_joined' event schema changed: expected (member: Address, amount: i128)"
        );
    }

    #[test]
    fn test_contribution_made_event_schema() {
        use soroban_sdk::{testutils::Events, TryFromVal};

        let env = Env::default();
        env.mock_all_auths();
        let (_, members, _, _, client) = setup(&env);
        for m in members.iter() { client.join(m); }

        let member = members.get(0).unwrap();
        env.ledger().with_mut(|l| l.timestamp = 86401);
        client.payout();
        client.contribute(&member, &100_000_000);

        let sym = Symbol::new(&env, "contribution_made");
        let found = env.events().all().iter().any(|(_, topics, data)| {
            if topics.len() != 1 { return false; }
            let Ok(t) = Symbol::try_from_val(&env, &topics.get(0).unwrap()) else { return false; };
            if t != sym { return false; }
            let Ok((m, amount, cycle)) = <(Address, i128, u32)>::try_from_val(&env, data) else { return false; };
            m == member && amount == 100_000_000 && cycle == 2
        });
        assert!(
            found,
            "'contribution_made' event schema changed: expected (member: Address, amount: i128, cycle: u32)"
        );
    }
}

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod benchmarks;

#[cfg(test)]
mod fuzz_tests;

#[cfg(test)]
mod policy_tests;

#[cfg(test)]
mod hardening_tests;
