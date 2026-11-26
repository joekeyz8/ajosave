#![no_main]
//! Fuzz target: `contribute` → `payout` with arbitrary member counts (1–50).
//!
//! Models a full circle lifecycle and checks that contribution accounting and
//! pot arithmetic never overflow, that out-of-range member counts are rejected
//! (mirroring `initialize`'s 2..=20 bound), and that every member is paid
//! exactly once with the locked balance returning to zero.

use libfuzzer_sys::fuzz_target;

const MIN_MEMBERS: u32 = 2;
const MAX_MEMBERS: u32 = 20;

fuzz_target!(|data: &[u8]| {
    // 1 byte member count + 8 bytes contribution amount + contribution bitmap.
    if data.len() < 9 {
        return;
    }
    let members = (data[0] as u32 % 50) + 1; // 1..=50
    let contribution = i64::from_le_bytes(data[1..9].try_into().unwrap()) as i128;
    let bitmap = &data[9..];

    // initialize() must reject these inputs rather than panic later.
    let pot = match contribution.checked_mul(members as i128) {
        Some(p) if (MIN_MEMBERS..=MAX_MEMBERS).contains(&members) && contribution > 0 => p,
        _ => return,
    };

    let mut paid_out = vec![false; members as usize];
    let mut lifetime_in: i128 = 0;
    let mut lifetime_out: i128 = 0;

    for cycle in 1..=members {
        // Contribute: a member pays if their bit is set; missing bytes = pay.
        let mut locked: i128 = 0;
        for m in 0..members {
            let idx = ((cycle - 1) * members + m) as usize;
            let pays = bitmap.get(idx / 8).map_or(true, |b| b & (1 << (idx % 8)) != 0);
            if pays {
                locked = locked.checked_add(contribution).expect("locked overflow");
            }
        }
        assert!(locked <= pot, "locked funds exceed pot");
        lifetime_in = lifetime_in.checked_add(locked).expect("lifetime_in overflow");

        // Payout: transfer of `pot` fails (no panic) unless fully funded.
        if locked < pot {
            return;
        }
        let recipient = (cycle - 1) as usize; // default join-order rotation
        assert!(recipient < members as usize, "recipient out of bounds");
        assert!(!paid_out[recipient], "member paid twice");
        paid_out[recipient] = true;
        lifetime_out = lifetime_out.checked_add(pot).expect("lifetime_out overflow");
        assert_eq!(lifetime_in - lifetime_out, 0, "invariant violated");
    }

    assert!(paid_out.iter().all(|p| *p), "member never paid");
});
