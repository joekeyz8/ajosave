"use client";

import { useState, useEffect } from "react";
import type { Circle, Member } from "@/types";
import { Button } from "@/components/ui/Button";
import { MemberAvatar } from "@/components/ui/MemberAvatar";
import styles from "./MemberPayoutList.module.css";

interface Props {
  circle: Circle;
  initialMembers: Member[];
  isCreator: boolean;
  currentUserId?: string;
}

interface ReputationMap {
  [userId: string]: number | undefined;
}

/** Fetch reputation score for a single user from the API. */
async function fetchReputation(userId: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/users/${userId}/reputation`);
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.data?.score === "number" ? json.data.score : null;
  } catch {
    return null;
  }
}

export function MemberPayoutList({ circle, initialMembers, isCreator, currentUserId }: Props) {
  // Sort active members by payout position; pending members appear at the bottom.
  const [members, setMembers] = useState<Member[]>(
    [...initialMembers].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return 1;
      if (a.status !== "pending" && b.status === "pending") return -1;
      return (a.position ?? 0) - (b.position ?? 0);
    })
  );
  const [shuffling, setShuffling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reputation, setReputation] = useState<ReputationMap>({});

  // Fetch reputation scores for all active members.
  useEffect(() => {
    const activeMembers = members.filter((m) => m.status !== "pending");
    if (activeMembers.length === 0) return;

    let cancelled = false;
    Promise.all(
      activeMembers.map(async (m) => {
        const score = await fetchReputation(m.userId);
        return { userId: m.userId, score };
      })
    ).then((results) => {
      if (cancelled) return;
      const map: ReputationMap = {};
      for (const r of results) {
        if (r.score !== null) map[r.userId] = r.score;
      }
      setReputation(map);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleShuffle = async () => {
    setShuffling(true);
    setError(null);
    try {
      const res = await fetch(`/api/circles/${circle.id}/shuffle`, { method: "POST" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setMembers(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Shuffle failed");
    } finally {
      setShuffling(false);
    }
  };

  const activeMembers = members.filter((m) => m.status !== "pending");
  const pendingMembers = members.filter((m) => m.status === "pending");

  return (
    <div className="card">
      <div className={styles.header}>
        <h2 className={styles.title}>
          Members{" "}
          <span className={styles.count}>({activeMembers.length}{pendingMembers.length > 0 ? `+${pendingMembers.length} pending` : ""})</span>
        </h2>
        {isCreator && circle.status === "open" && circle.payoutMethod !== "randomized" && (
          <Button variant="ghost" size="sm" onClick={handleShuffle} loading={shuffling}>
            🔀 Randomize
          </Button>
        )}
      </div>

      {circle.payoutMethod === "randomized" && circle.randomizationSeed && (
        <p style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.5rem", wordBreak: "break-all" }}>
          🔒 Order locked · Seed: <code>{circle.randomizationSeed}</code>
        </p>
      )}
      {circle.payoutMethod === "randomized" && !circle.randomizationSeed && (
        <p style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
          🎲 Order will be randomized and locked when the circle fills.
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {/* ── Active / confirmed members ── */}
      {activeMembers.length === 0 ? (
        <p className={styles.empty}>No members yet.</p>
      ) : (
        <ol className={styles.list} aria-label="Payout rotation order">
          {activeMembers.map((m) => {
            const isCurrent = circle.status === "active" && m.position === circle.currentCycle;
            const isPast = m.hasReceivedPayout;
            const isMe = !!currentUserId && m.userId === currentUserId;
            const isAdmin = m.userId === circle.creatorId;
            const repScore = reputation[m.userId];

            return (
              <li
                key={m.id}
                className={[
                  styles.item,
                  isCurrent ? styles.current : "",
                  isPast ? styles.past : "",
                  isMe ? styles.me : "",
                ].join(" ")}
                aria-current={isCurrent ? "true" : undefined}
              >
                {/* Payout position badge */}
                <span className={styles.cycle} aria-label={`Payout position ${m.position}`}>
                  {m.position}
                </span>

                <MemberAvatar displayName={m.displayName} userId={m.userId} />

                <span className={styles.memberName}>
                  {m.displayName ?? `Member ${m.userId.slice(0, 8)}…`}
                  {isMe && <span className={styles.youBadge}>you</span>}
                  {isAdmin && (
                    <span className={styles.adminBadge} aria-label="Circle admin">
                      Admin
                    </span>
                  )}
                </span>

                {/* Reputation score */}
                {repScore !== undefined && (
                  <span
                    className={styles.reputationBadge}
                    title={`Reputation score: ${repScore}/100`}
                    aria-label={`Reputation ${repScore}`}
                  >
                    ⭐ {repScore}
                  </span>
                )}

                <span className={styles.statusTag}>
                  {isPast && <span className={`${styles.tag} ${styles.tagDone}`}>Paid out ✓</span>}
                  {isCurrent && <span className={`${styles.tag} ${styles.tagActive}`}>Receiving now</span>}
                  {!isPast && !isCurrent && circle.status === "active" && (
                    <span className={`${styles.tag} ${styles.tagPending}`}>Cycle {m.position}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Pending-approval members (admin view only) ── */}
      {isCreator && pendingMembers.length > 0 && (
        <section
          className={styles.pendingSection}
          aria-labelledby="pending-members-heading"
        >
          <h3 id="pending-members-heading" className={styles.pendingHeading}>
            Awaiting Approval ({pendingMembers.length})
          </h3>
          <ul className={styles.list} aria-label="Pending members awaiting approval">
            {pendingMembers.map((m) => (
              <li key={m.id} className={`${styles.item} ${styles.pendingItem}`}>
                <MemberAvatar displayName={m.displayName} userId={m.userId} />
                <span className={styles.memberName}>
                  {m.displayName ?? `Member ${m.userId.slice(0, 8)}…`}
                </span>
                <span className={styles.statusTag}>
                  <span className={`${styles.tag} ${styles.tagAwaiting}`} aria-label="Awaiting approval">
                    Awaiting approval
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
