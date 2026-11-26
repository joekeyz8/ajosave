//! Tests for issues #449 (structured events), #450 (full-circle lifecycle)
//! and #452 (multi-sig pause / guardian emergency pause).

extern crate std;

use crate::{AjoContract, AjoContractClient, Error, EMERGENCY_PAUSE_TTL_SECS};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Symbol, TryFromVal, Vec,
};

const CONTRIBUTION: i128 = 100_000_000;
const INTERVAL: u64 = 86_400;

struct Ctx {
    env: Env,
    admin: Address,
    members: Vec<Address>,
    token: TokenClient<'static>,
    client: AjoContractClient<'static>,
}

fn setup(max_members: u32) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(admin.clone());
    let token_admin = StellarAssetClient::new(&env, &token_id);
    let mut members = Vec::new(&env);
    for _ in 0..max_members {
        let m = Address::generate(&env);
        token_admin.mint(&m, &(CONTRIBUTION * (max_members as i128 + 1)));
        members.push_back(m);
    }
    let client = AjoContractClient::new(&env, &env.register_contract(None, AjoContract));
    client.initialize(
        &admin,
        &token_id,
        &admin,
        &CONTRIBUTION,
        &max_members,
        &INTERVAL,
    );
    // SAFETY: env outlives the clients for the duration of each test.
    let token: TokenClient<'static> =
        unsafe { std::mem::transmute(TokenClient::new(&env, &token_id)) };
    let client: AjoContractClient<'static> = unsafe { std::mem::transmute(client) };
    Ctx {
        env,
        admin,
        members,
        token,
        client,
    }
}

/// True if the most recent invocation emitted an event with this topic.
fn emitted(env: &Env, topic: &str) -> bool {
    let want = Symbol::new(env, topic);
    env.events().all().iter().any(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|t| Symbol::try_from_val(env, &t).ok())
            .map_or(false, |s| s == want)
    })
}

// ─── #450 full-circle lifecycle ───────────────────────────────────────────────

fn run_full_circle(n: u32) {
    let c = setup(n);
    for m in c.members.iter() {
        c.client.join(&m);
    }
    let pot = CONTRIBUTION * n as i128;
    let mut received = std::vec![false; n as usize];

    for cycle in 1..=n {
        if cycle > 1 {
            for m in c.members.iter() {
                c.client.contribute(&m, &CONTRIBUTION);
            }
        }
        let (cur, _, next_payout, completed, _) = c.client.get_state();
        assert_eq!(cur, cycle);
        assert!(!completed);

        c.env.ledger().with_mut(|l| l.timestamp = next_payout);
        let recipient = c.members.get(cycle - 1).unwrap();
        let before = c.token.balance(&recipient);
        c.client.payout();
        assert_eq!(
            c.token.balance(&recipient) - before,
            pot,
            "cycle {cycle}: wrong payout"
        );
        received[(cycle - 1) as usize] = true;
    }

    let (_, _, _, completed, _) = c.client.get_state();
    assert!(completed, "circle must be Completed after {n} payouts");
    assert!(
        received.iter().all(|r| *r),
        "every member must receive a payout"
    );
    assert_eq!(c.token.balance(&c.client.address), 0);
}

#[test]
fn full_circle_2_members() {
    run_full_circle(2);
}

#[test]
fn full_circle_5_members() {
    run_full_circle(5);
}

#[test]
fn full_circle_10_members() {
    run_full_circle(10);
}

// ─── #449 events for every entry point ────────────────────────────────────────

#[test]
fn every_entry_point_emits_event() {
    let c = setup(2);
    let (a, b) = (c.members.get(0).unwrap(), c.members.get(1).unwrap());

    c.client.set_payout_order(&vec![&c.env, 0u32, 1u32]);
    assert!(emitted(&c.env, "PayoutOrderSet"));
    c.client.set_missed_policy(&1);
    assert!(emitted(&c.env, "missed_policy_updated"));
    c.client.set_ttl_config(&100_000, &600_000);
    assert!(emitted(&c.env, "ttl_config_updated"));

    c.client.join(&a);
    assert!(emitted(&c.env, "member_joined"));
    c.client.join(&b);
    assert!(emitted(&c.env, "circle_started"));

    c.env.ledger().with_mut(|l| l.timestamp = INTERVAL);
    c.client.payout();
    assert!(emitted(&c.env, "payout_sent"));
    c.client.contribute(&a, &CONTRIBUTION);
    assert!(emitted(&c.env, "contribution_made"));
    c.client.contribute(&b, &CONTRIBUTION);

    c.env.ledger().with_mut(|l| l.timestamp = 2 * INTERVAL);
    c.client.payout();
    assert!(emitted(&c.env, "circle_completed"));
    c.client.reinstate_member(&b);
    assert!(emitted(&c.env, "member_reinstated"));

    let hash = soroban_sdk::BytesN::from_array(&c.env, &[7u8; 32]);
    c.client.propose_upgrade(&hash);
    assert!(emitted(&c.env, "upgrade_proposed"));
    c.client.cancel_upgrade();
    assert!(emitted(&c.env, "upgrade_cancelled"));

    let new_admin = Address::generate(&c.env);
    c.client.propose_admin(&new_admin);
    assert!(emitted(&c.env, "admin_proposed"));
    c.client.accept_admin();
    assert!(emitted(&c.env, "admin_transferred"));

    let guardian = Address::generate(&c.env);
    c.client.set_guardian(&guardian);
    assert!(emitted(&c.env, "GuardianUpdated"));
    c.client
        .set_pause_signers(&vec![&c.env, new_admin.clone()], &1);
    assert!(emitted(&c.env, "PauseSignersUpdated"));
    c.client.pause(&vec![&c.env, new_admin.clone()]);
    assert!(emitted(&c.env, "CirclePaused"));
    c.client.unpause();
    assert!(emitted(&c.env, "CircleUnpaused"));
    c.client.emergency_pause();
    assert!(emitted(&c.env, "CirclePaused"));
}

// ─── #452 multi-sig pause / guardian ──────────────────────────────────────────

fn signers(c: &Ctx, n: u32) -> Vec<Address> {
    let mut v = Vec::new(&c.env);
    for _ in 0..n {
        v.push_back(Address::generate(&c.env));
    }
    v
}

#[test]
fn pause_requires_threshold_approvals() {
    let c = setup(2);
    let s = signers(&c, 3);
    c.client.set_pause_signers(&s, &2);

    let one = vec![&c.env, s.get(0).unwrap()];
    assert_eq!(
        c.client.try_pause(&one),
        Err(Ok(soroban_sdk::Error::from_contract_error(
            Error::InsufficientApprovals as u32
        )))
    );

    let two = vec![&c.env, s.get(0).unwrap(), s.get(2).unwrap()];
    c.client.pause(&two);
    assert!(c.client.get_state().4);
}

#[test]
#[should_panic(expected = "approver is not a pause signer")]
fn pause_rejects_non_signer() {
    let c = setup(2);
    c.client.set_pause_signers(&signers(&c, 2), &1);
    c.client.pause(&vec![&c.env, c.admin.clone()]);
}

#[test]
#[should_panic(expected = "duplicate approver")]
fn pause_rejects_duplicate_approver() {
    let c = setup(2);
    let s = signers(&c, 2);
    c.client.set_pause_signers(&s, &2);
    c.client
        .pause(&vec![&c.env, s.get(0).unwrap(), s.get(0).unwrap()]);
}

#[test]
fn paused_blocks_entry_points_except_unpause_and_views() {
    let c = setup(2);
    c.client.pause(&vec![&c.env, c.admin.clone()]);

    let m = c.members.get(0).unwrap();
    assert_eq!(c.client.try_join(&m), Err(Ok(Error::CirclePaused)));
    assert_eq!(c.client.try_payout(), Err(Ok(Error::CirclePaused)));
    assert!(c
        .client
        .try_set_payout_order(&vec![&c.env, 1u32, 0u32])
        .is_err());
    assert!(c.client.try_set_missed_policy(&1).is_err());
    assert!(c.client.try_propose_admin(&m).is_err());
    assert!(c.client.try_set_guardian(&m).is_err());
    assert!(c
        .client
        .try_propose_upgrade(&soroban_sdk::BytesN::from_array(&c.env, &[1u8; 32]))
        .is_err());

    // Views still work, and unpause lifts the pause.
    let _ = c.client.get_members();
    c.client.unpause();
    assert!(!c.client.get_state().4);
    c.client.join(&m);
}

#[test]
fn emergency_pause_expires_after_24h_without_confirmation() {
    let c = setup(2);
    let guardian = Address::generate(&c.env);
    c.client.set_guardian(&guardian);

    c.client.emergency_pause();
    let m = c.members.get(0).unwrap();
    assert_eq!(c.client.try_join(&m), Err(Ok(Error::CirclePaused)));

    c.env
        .ledger()
        .with_mut(|l| l.timestamp = EMERGENCY_PAUSE_TTL_SECS - 1);
    assert!(c.client.get_state().4);
    c.env
        .ledger()
        .with_mut(|l| l.timestamp = EMERGENCY_PAUSE_TTL_SECS);
    assert!(
        !c.client.get_state().4,
        "unconfirmed emergency pause must lapse"
    );
    c.client.join(&m);
}

#[test]
fn multisig_confirms_emergency_pause() {
    let c = setup(2);
    c.client.set_guardian(&Address::generate(&c.env));
    c.client.emergency_pause();
    c.client.pause(&vec![&c.env, c.admin.clone()]);

    c.env
        .ledger()
        .with_mut(|l| l.timestamp = EMERGENCY_PAUSE_TTL_SECS * 2);
    assert!(c.client.get_state().4, "confirmed pause must not expire");
}
