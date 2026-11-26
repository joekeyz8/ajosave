import logger from "@/lib/logger";
import { query } from "@/lib/db";

// Score adjustments
const SCORE_INCREMENT = 5; // Points added on-time contribution
const SCORE_DECREMENT = 10; // Points deducted on missed contribution
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const DECAY_PERIOD_DAYS = 180; // Score decays linearly to 0 over 6 months of inactivity
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Update user reputation score when a contribution is confirmed.
 * Called after successful payment confirmation.
 */
export async function incrementReputationOnContribution(userId: string): Promise<number> {
  const { rows } = await query<{ reputation_score: number }>(
    `UPDATE users 
     SET reputation_score = LEAST(reputation_score + $1, $2)
     WHERE id = $3
     RETURNING reputation_score`,
    [SCORE_INCREMENT, MAX_SCORE, userId]
  );

  return rows[0]?.reputation_score ?? 0;
}

/**
 * Update user reputation score when a contribution is missed/defaulted.
 * Called when processing missed contributions.
 */
export async function decrementReputationOnMissedContribution(userId: string): Promise<number> {
  const { rows } = await query<{ reputation_score: number }>(
    `UPDATE users 
     SET reputation_score = GREATEST(reputation_score - $1, $2)
     WHERE id = $3
     RETURNING reputation_score`,
    [SCORE_DECREMENT, MIN_SCORE, userId]
  );

  return rows[0]?.reputation_score ?? 0;
}

/**
 * Get user's current reputation score.
 */
export async function getUserReputation(userId: string): Promise<number> {
  const { rows } = await query<{ reputation_score: number }>(
    `SELECT reputation_score FROM users WHERE id = $1`,
    [userId]
  );

  return rows[0]?.reputation_score ?? 0;
}

/**
 * Check if user meets the minimum reputation requirement for a circle.
 */
export async function checkReputationGate(
  userId: string,
  requiredScore: number
): Promise<{ eligible: boolean; currentScore: number }> {
  const currentScore = await getUserReputation(userId);

  return {
    eligible: currentScore >= requiredScore,
    currentScore,
  };
}

/**
 * Calculate reputation level label based on score.
 */
export function getReputationLevel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Building";
}

/**
 * Apply linear reputation decay for inactive members (issue #441).
 *
 * Inactivity is measured from the member's last confirmed contribution (or
 * account creation). The score decays linearly from its value at the start of
 * the inactivity period down to 0 after 6 months, never going negative. Each
 * change is recorded in `reputation_score_history` for audit purposes.
 * Intended to run nightly; repeated runs are idempotent.
 *
 * @returns Number of users whose score was decayed
 */
export async function applyReputationDecay(now: Date = new Date()): Promise<number> {
  const { rows: users } = await query<{ id: string; score: number; lastActive: Date }>(
    `SELECT u.id, u.reputation_score AS score,
            COALESCE(MAX(c.created_at), u.created_at) AS "lastActive"
     FROM users u
     LEFT JOIN members m ON m.user_id = u.id
     LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'confirmed'
     WHERE u.reputation_score > $1
     GROUP BY u.id
     HAVING COALESCE(MAX(c.created_at), u.created_at) < $2`,
    [MIN_SCORE, new Date(now.getTime() - DAY_MS)]
  );

  let decayed = 0;
  for (const user of users) {
    const lastActive = new Date(user.lastActive);
    const { rows: history } = await query<{ base_score: number }>(
      `SELECT base_score FROM reputation_score_history
       WHERE user_id = $1 AND reason = 'inactivity_decay' AND created_at > $2
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, lastActive]
    );
    const base = history[0]?.base_score ?? user.score;
    const inactiveDays = Math.min(
      Math.floor((now.getTime() - lastActive.getTime()) / DAY_MS),
      DECAY_PERIOD_DAYS
    );
    const target = Math.max(MIN_SCORE, Math.floor(base * (1 - inactiveDays / DECAY_PERIOD_DAYS)));
    if (target >= user.score) continue;

    const { rowCount } = await query(
      `WITH updated AS (
         UPDATE users SET reputation_score = $2
         WHERE id = $1 AND reputation_score = $3
         RETURNING id
       )
       INSERT INTO reputation_score_history (user_id, previous_score, new_score, base_score, reason)
       SELECT id, $3, $2, $4, 'inactivity_decay' FROM updated`,
      [user.id, target, user.score, base]
    );
    if (rowCount) decayed++;
  }

  return decayed;
}
