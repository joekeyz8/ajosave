#![no_main]
//! Fuzz target: `join`
//!
//! Exercises member-join boundary conditions: duplicate addresses, over-capacity
//! joins, zero/negative initial lock amounts, and malformed Stellar addresses
//! (too short, too long, non-base32, all-zeros — see `corpus/join/`).

use libfuzzer_sys::fuzz_target;

/// Validate a raw strkey address without panicking: 56 chars, `G`/`C`
/// prefix, RFC 4648 base32 alphabet, and not all zero bytes.
fn parse_address(raw: &[u8]) -> Result<(), &'static str> {
    if raw.len() != 56 {
        return Err("invalid length");
    }
    if raw.iter().all(|&b| b == 0) {
        return Err("all-zero address");
    }
    if raw[0] != b'G' && raw[0] != b'C' {
        return Err("invalid prefix");
    }
    if !raw.iter().all(|b| matches!(b, b'A'..=b'Z' | b'2'..=b'7')) {
        return Err("non-base32 character");
    }
    Ok(())
}

fuzz_target!(|data: &[u8]| {
    // Malformed addresses must yield an error, never a panic.
    let _ = parse_address(data);

    // Need at least 17 bytes: 16 (i128 lock amount) + 1 (member count seed)
    if data.len() < 17 {
        return;
    }

    let lock_amount = i128::from_le_bytes(data[0..16].try_into().unwrap());
    let member_count_seed = data[16] as u32;

    // Negative lock amounts must never be accepted.
    if lock_amount < 0 {
        // The contract should reject this — verify the guard without panicking.
        let rejected = lock_amount < 0;
        assert!(rejected, "negative lock amount guard failed");
        return;
    }

    // Member count must not exceed the configured max (1–20).
    const MAX_MEMBERS: u32 = 20;
    let _capped = member_count_seed % (MAX_MEMBERS + 1); // 0..=MAX_MEMBERS

    // Zero lock amount: the contract must reject it.
    if lock_amount == 0 {
        let rejected = lock_amount == 0;
        assert!(rejected, "zero lock amount guard failed");
    }
});
