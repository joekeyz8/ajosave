//! Ajosave Certificate Contract
//!
//! Issues non-transferable on-chain completion certificates to members who
//! finish a full savings circle. Each certificate is a persistent storage
//! record keyed by (member_address, circle_id).
//!
//! Certificates are soul-bound: there is no way to move a certificate to a
//! different address, and `transfer` always panics.
//!
//! ## Functions
//! - `mint`             — admin mints a certificate for a member (idempotent)
//! - `add_minter`       — admin authorises an Ajo circle contract to mint
//! - `mint_from_circle` — an authorised Ajo contract mints on circle completion
//! - `get`              — read a certificate by member + circle
//! - `has`              — check whether a certificate exists
//! - `transfer`         — always panics (soul-bound)

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, String, Symbol};

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// Certificate keyed by (member_address, circle_id_bytes)
    Cert(Address, BytesN<32>),
    /// Ajo circle contracts allowed to call `mint_from_circle`
    Minter(Address),
}

// ─── Certificate data ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct Certificate {
    pub member:          Address,
    pub circle_id:       BytesN<32>,
    pub circle_name:     String,
    pub cycles_completed: u32,
    pub total_saved_usdc: i128, // in stroops (7 decimal places)
    pub payout_amount:   i128,  // payout received by the member, in stroops
    pub issued_at:       u64,   // Unix timestamp (ledger close time)
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct CertificateContract;

#[contractimpl]
impl CertificateContract {
    /// One-time initialisation — sets the admin address.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Mint a certificate for `member` on completion of `circle_id`.
    /// Idempotent: calling again for the same (member, circle_id) is a no-op.
    pub fn mint(
        env: Env,
        member: Address,
        circle_id: BytesN<32>,
        circle_name: String,
        cycles_completed: u32,
        total_saved_usdc: i128,
    ) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        // Each member receives the full pot once, which equals their total saved.
        Self::store_cert(&env, member, circle_id, circle_name, cycles_completed, total_saved_usdc, total_saved_usdc);
    }

    /// Authorise an Ajo circle contract to mint certificates on completion. Admin-only.
    pub fn add_minter(env: Env, minter: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Minter(minter), &true);
    }

    /// Mint a soul-bound certificate from an authorised Ajo circle contract.
    /// Called by the Ajo contract for each member when the circle completes.
    /// Idempotent per (member, circle_id).
    pub fn mint_from_circle(
        env: Env,
        minter: Address,
        member: Address,
        circle_id: BytesN<32>,
        cycles_completed: u32,
        total_saved_usdc: i128,
        payout_amount: i128,
    ) {
        minter.require_auth();
        if !env.storage().persistent().has(&DataKey::Minter(minter)) {
            panic!("unauthorized minter");
        }
        Self::store_cert(
            &env,
            member,
            circle_id,
            String::from_str(&env, ""),
            cycles_completed,
            total_saved_usdc,
            payout_amount,
        );
    }

    /// Certificates are soul-bound and can never be transferred.
    pub fn transfer(_env: Env, _from: Address, _to: Address, _circle_id: BytesN<32>) {
        panic!("certificate is soul-bound and non-transferable");
    }

    /// Retrieve a certificate. Returns None if not found.
    pub fn get(env: Env, member: Address, circle_id: BytesN<32>) -> Option<Certificate> {
        env.storage()
            .persistent()
            .get(&DataKey::Cert(member, circle_id))
    }

    /// Check whether a certificate exists for (member, circle_id).
    pub fn has(env: Env, member: Address, circle_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Cert(member, circle_id))
    }
}

impl CertificateContract {
    fn store_cert(
        env: &Env,
        member: Address,
        circle_id: BytesN<32>,
        circle_name: String,
        cycles_completed: u32,
        total_saved_usdc: i128,
        payout_amount: i128,
    ) {
        let key = DataKey::Cert(member.clone(), circle_id.clone());
        if env.storage().persistent().has(&key) {
            return; // idempotent
        }

        let cert = Certificate {
            member,
            circle_id,
            circle_name,
            cycles_completed,
            total_saved_usdc,
            payout_amount,
            issued_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&key, &cert);

        env.events().publish((Symbol::new(env, "cert_minted"),), cert);
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, CertificateContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CertificateContract);
        let client = CertificateContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn circle_id(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[1u8; 32])
    }

    #[test]
    fn mint_and_get() {
        let (env, client, _) = setup();
        let member = Address::generate(&env);
        let cid = circle_id(&env);
        let name = String::from_str(&env, "Test Circle");

        client.mint(&member, &cid, &name, &3, &300_000_000);

        let cert = client.get(&member, &cid).unwrap();
        assert_eq!(cert.cycles_completed, 3);
        assert_eq!(cert.total_saved_usdc, 300_000_000);
        assert!(client.has(&member, &cid));
    }

    #[test]
    fn mint_is_idempotent() {
        let (env, client, _) = setup();
        let member = Address::generate(&env);
        let cid = circle_id(&env);
        let name = String::from_str(&env, "Test Circle");

        client.mint(&member, &cid, &name, &3, &300_000_000);
        client.mint(&member, &cid, &name, &3, &300_000_000); // second call — no panic
    }

    #[test]
    fn get_returns_none_for_missing() {
        let (env, client, _) = setup();
        let member = Address::generate(&env);
        let cid = circle_id(&env);
        assert!(client.get(&member, &cid).is_none());
        assert!(!client.has(&member, &cid));
    }

    #[test]
    fn mint_from_authorised_circle() {
        let (env, client, _) = setup();
        let circle = Address::generate(&env);
        let member = Address::generate(&env);
        let cid = circle_id(&env);

        client.add_minter(&circle);
        client.mint_from_circle(&circle, &member, &cid, &3, &300_000_000, &300_000_000);

        let cert = client.get(&member, &cid).unwrap();
        assert_eq!(cert.payout_amount, 300_000_000);
        assert_eq!(cert.cycles_completed, 3);
    }

    #[test]
    #[should_panic(expected = "unauthorized minter")]
    fn mint_from_unknown_circle_panics() {
        let (env, client, _) = setup();
        let circle = Address::generate(&env);
        let member = Address::generate(&env);
        client.mint_from_circle(&circle, &member, &circle_id(&env), &3, &1, &1);
    }

    #[test]
    #[should_panic(expected = "soul-bound")]
    fn transfer_panics() {
        let (env, client, _) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.transfer(&a, &b, &circle_id(&env));
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn double_initialize_panics() {
        let (env, client, admin) = setup();
        client.initialize(&admin);
    }
}
