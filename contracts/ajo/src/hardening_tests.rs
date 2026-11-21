//! Integration tests for TTL bumping (#445), member reinstatement (#446),
//! packed contribution state (#447) and multi-sig payouts (#448).

#[cfg(test)]
mod hardening {
    use crate::{AjoContract, AjoContractClient};
    use soroban_sdk::{
        testutils::{storage::Instance as _, Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        vec, Address, Env, Vec,
    };

    const CONTRIBUTION: i128 = 100_000_000;
    const INTERVAL: u64 = 86_400;

    struct Fx<'a> {
        env: Env,
        id: Address,
        members: Vec<Address>,
        token: TokenClient<'a>,
        client: AjoContractClient<'a>,
    }

    fn setup(n: u32) -> Fx<'static> {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| {
            l.min_persistent_entry_ttl = 200_000;
            l.min_temp_entry_ttl = 200_000;
            l.max_entry_ttl = 1_000_000;
        });
        let admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(admin.clone());
        let token_admin = StellarAssetClient::new(&env, &token_id);
        let mut members = Vec::new(&env);
        for _ in 0..n {
            let m = Address::generate(&env);
            token_admin.mint(&m, &(CONTRIBUTION * 10));
            members.push_back(m);
        }
        let id = env.register_contract(None, AjoContract);
        let client = AjoContractClient::new(&env, &id);
        client.initialize(&admin, &token_id, &admin, &CONTRIBUTION, &n, &INTERVAL);
        let token = TokenClient::new(&env, &token_id);
        Fx {
            env,
            id,
            members,
            token,
            client,
        }
    }

    fn join_all(f: &Fx) {
        for m in f.members.iter() {
            f.client.join(&m);
        }
    }

    fn instance_ttl(f: &Fx) -> u32 {
        f.env
            .as_contract(&f.id, || f.env.storage().instance().get_ttl())
    }

    /// Advance ledgers until the instance TTL drops below the bump threshold.
    fn age(f: &Fx) {
        let ttl = instance_ttl(f);
        f.env.ledger().with_mut(|l| l.sequence_number += ttl - 100);
    }

    // ── #445 ──────────────────────────────────────────────────────────────────

    #[test]
    fn every_entry_point_bumps_instance_ttl() {
        macro_rules! bumps {
            ($f:ident, $m:ident => $call:expr) => {{
                let $f = setup(3);
                #[allow(unused_variables)]
                let $m = $f.members.get(0).unwrap();
                let f = &$f;
                age(&f);
                let before = instance_ttl(&f);
                $call;
                assert!(
                    instance_ttl(&f) > before,
                    "{} did not bump TTL",
                    stringify!($call)
                );
            }};
        }
        bumps!(f, m => f.client.get_state());
        bumps!(f, m => f.client.get_members());
        bumps!(f, m => f.client.get_token());
        bumps!(f, m => f.client.get_payout_order());
        bumps!(f, m => f.client.get_contribution_status(&1));
        bumps!(f, m => f.client.get_reputation(&m));
        bumps!(f, m => f.client.get_reputation_stats(&m));
        bumps!(f, m => f.client.get_missed_policy());
        bumps!(f, m => f.client.get_missed_contributions(&m));
        bumps!(f, m => f.client.is_suspended(&m));
        bumps!(f, m => f.client.migrate());
        bumps!(f, m => f.client.set_ttl_config(&17_280, &(7 * 17_280)));
        bumps!(f, m => f.client.pause());
        bumps!(f, m => f.client.unpause());
        bumps!(f, m => f.client.propose_admin(&m));
        bumps!(f, m => f.client.set_payout_order(&vec![&f.env, 0u32, 1, 2]));
        bumps!(f, m => f.client.configure_payout_multisig(&1, &vec![&f.env, m.clone()], &1));
        bumps!(f, m => f.client.join(&m));
    }

    // ── #446 / #447 ───────────────────────────────────────────────────────────

    #[test]
    fn suspended_member_pays_missed_plus_penalty_to_reinstate() {
        let f = setup(3);
        join_all(&f);
        let late = f.members.get(2).unwrap();

        // Cycle 1 paid at join; cycle 2 missed by `late` only.
        f.env.ledger().with_mut(|l| l.timestamp = INTERVAL + 1);
        f.client.payout();
        f.client
            .contribute(&f.members.get(0).unwrap(), &CONTRIBUTION);
        f.client
            .contribute(&f.members.get(1).unwrap(), &CONTRIBUTION);
        // The pot is fixed at contribution × members; cover the missed share.
        StellarAssetClient::new(&f.env, &f.token.address).mint(&f.id, &CONTRIBUTION);
        assert_eq!(f.client.get_contribution_status(&2).get(0).unwrap().1, true);
        f.env.ledger().with_mut(|l| l.timestamp = 2 * INTERVAL + 2);
        f.client.payout();
        assert!(f.client.is_suspended(&late));

        let before = f.token.balance(&late);
        f.client.reinstate_member(&late);
        assert!(!f.client.is_suspended(&late));
        // 1 missed cycle + 10% penalty.
        assert_eq!(
            before - f.token.balance(&late),
            CONTRIBUTION + CONTRIBUTION / 10
        );

        f.client.contribute(&late, &CONTRIBUTION);
    }

    #[test]
    #[should_panic(expected = "member is not suspended")]
    fn reinstate_rejects_active_member() {
        let f = setup(2);
        join_all(&f);
        f.client.reinstate_member(&f.members.get(0).unwrap());
    }

    #[test]
    #[should_panic(expected = "already contributed this cycle")]
    fn packed_state_blocks_double_contribution() {
        let f = setup(2);
        join_all(&f);
        f.env.ledger().with_mut(|l| l.timestamp = INTERVAL + 1);
        f.client.payout();
        let m = f.members.get(0).unwrap();
        f.client.contribute(&m, &CONTRIBUTION);
        f.client.contribute(&m, &CONTRIBUTION);
    }

    // ── #448 ──────────────────────────────────────────────────────────────────

    fn multisig(f: &Fx) -> Vec<Address> {
        let signers = vec![
            &f.env,
            Address::generate(&f.env),
            Address::generate(&f.env),
            Address::generate(&f.env),
        ];
        // Pot is 2 × CONTRIBUTION, so any threshold below it applies.
        f.client
            .configure_payout_multisig(&CONTRIBUTION, &signers, &2);
        signers
    }

    #[test]
    #[should_panic(expected = "multisig approval required")]
    fn large_payout_requires_m_of_n() {
        let f = setup(2);
        let s = multisig(&f);
        join_all(&f);
        f.client.approve_payout(&s.get(0).unwrap());
        f.env.ledger().with_mut(|l| l.timestamp = INTERVAL + 1);
        f.client.payout();
    }

    #[test]
    fn large_payout_executes_with_m_of_n() {
        let f = setup(2);
        let s = multisig(&f);
        join_all(&f);
        f.client.approve_payout(&s.get(0).unwrap());
        f.client.approve_payout(&s.get(1).unwrap());
        assert_eq!(f.client.get_payout_approval(&1).unwrap().0, 2);
        f.env.ledger().with_mut(|l| l.timestamp = INTERVAL + 1);
        f.client.payout();
        assert!(f.client.get_payout_approval(&1).is_none());
    }

    #[test]
    #[should_panic(expected = "multisig approval required")]
    fn approvals_expire_after_48_hours() {
        let f = setup(2);
        let s = multisig(&f);
        join_all(&f);
        f.client.approve_payout(&s.get(0).unwrap());
        f.client.approve_payout(&s.get(1).unwrap());
        f.env.ledger().with_mut(|l| l.timestamp = 172_800 + 1);
        f.client.payout();
    }
}
