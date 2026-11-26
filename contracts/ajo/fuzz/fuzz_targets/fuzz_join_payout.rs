#![no_main]
//! Fuzz target: concurrent interleaving of `join` and `payout`.
//!
//! Each input byte is an operation (even = join by member `b >> 1`, odd =
//! payout). The model mirrors the contract's guards: joins are only accepted
//! before the circle starts, payouts only after it is full, cycles never
//! exceed `max_members`, and no member is ever paid twice.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }
    let max_members = (data[0] as u32 % 19) + 2; // 2..=20
    let mut joined: Vec<u8> = Vec::new();
    let mut current_cycle: u32 = 0;
    let mut completed = false;
    let mut paid = vec![false; max_members as usize];

    for &op in &data[1..] {
        if op & 1 == 0 {
            let who = op >> 1;
            // join(): rejected after start, when full, or on duplicates.
            if current_cycle > 0 || joined.len() as u32 >= max_members || joined.contains(&who) {
                continue;
            }
            joined.push(who);
            if joined.len() as u32 == max_members {
                current_cycle = 1;
            }
        } else {
            // payout(): rejected before start and after completion.
            if current_cycle == 0 || completed {
                continue;
            }
            let recipient = (current_cycle - 1) as usize;
            assert!(recipient < joined.len(), "recipient index out of bounds");
            assert!(!paid[recipient], "member paid twice");
            paid[recipient] = true;
            if current_cycle >= max_members {
                completed = true;
            } else {
                current_cycle = current_cycle.checked_add(1).expect("cycle overflow");
            }
        }
        assert!(current_cycle <= max_members, "cycle exceeded max_members");
        assert!(joined.len() as u32 <= max_members, "too many members");
    }

    if completed {
        assert!(paid.iter().all(|p| *p), "completed with unpaid member");
    }
});
