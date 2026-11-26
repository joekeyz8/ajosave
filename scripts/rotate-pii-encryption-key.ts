/**
 * PII Encryption Key Rotation Script — Issue #497
 *
 * Re-encrypts all phone and email ciphertext in the users table from the old key
 * to a new key. Run this whenever the encryption key is rotated.
 *
 * Usage:
 *   PII_ENCRYPTION_KEY=<old_key>  PII_HMAC_KEY=<old_hmac>  \
 *   PII_ENCRYPTION_KEY_NEW=<new_key> PII_HMAC_KEY_NEW=<new_hmac> \
 *   npx ts-node scripts/rotate-pii-encryption-key.ts
 *
 * The script operates row-by-row inside a transaction, so a failure leaves the
 * database in a consistent state (all old-key or all new-key, never mixed).
 *
 * After the script completes successfully:
 *   1. Set PII_ENCRYPTION_KEY=<new_key> and PII_HMAC_KEY=<new_hmac> in your env.
 *   2. Redeploy the application.
 *   3. Revoke the old key from your secrets manager.
 */
import { Pool, PoolClient } from "pg";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const ENCODING = "base64url" as BufferEncoding;

function loadKey(envVar: string): Buffer {
  const hex = process.env[envVar];
  if (!hex || hex.length !== 64) {
    throw new Error(`${envVar} must be a 64-char hex string (32 bytes)`);
  }
  return Buffer.from(hex, "hex");
}

function decryptWith(key: Buffer, encrypted: string): string {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload format");
  const [ivB64, ciphertextB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, ENCODING);
  const ciphertext = Buffer.from(ciphertextB64, ENCODING);
  const tag = Buffer.from(tagB64, ENCODING);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((b) => b.toString(ENCODING)).join(".");
}

function hmacIndexWith(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest(ENCODING);
}

async function main() {
  const oldEncKey = loadKey("PII_ENCRYPTION_KEY");
  const oldHmacKey = loadKey("PII_HMAC_KEY");
  const newEncKey = loadKey("PII_ENCRYPTION_KEY_NEW");
  const newHmacKey = loadKey("PII_HMAC_KEY_NEW");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      phone: string;
      email: string | null;
    }>("SELECT id, phone, email FROM users FOR UPDATE");

    console.log(`Rotating keys for ${rows.length} user(s)…`);

    let rotated = 0;
    let skipped = 0;

    for (const row of rows) {
      // Skip anonymized rows
      if (!row.phone || row.phone.startsWith("deleted-")) {
        skipped++;
        continue;
      }

      let plainPhone: string;
      try {
        plainPhone = decryptWith(oldEncKey, row.phone);
      } catch {
        // Already re-encrypted with the new key (re-run safety) — try new key
        try {
          plainPhone = decryptWith(newEncKey, row.phone);
        } catch {
          console.error(`[rotate] Cannot decrypt phone for user ${row.id} — skipping`);
          skipped++;
          continue;
        }
      }

      let plainEmail: string | null = null;
      if (row.email) {
        try {
          plainEmail = decryptWith(oldEncKey, row.email);
        } catch {
          try {
            plainEmail = decryptWith(newEncKey, row.email);
          } catch {
            console.error(`[rotate] Cannot decrypt email for user ${row.id} — using null`);
          }
        }
      }

      await client.query(
        `UPDATE users
         SET phone      = $1,
             phone_hash = $2,
             email      = $3
         WHERE id = $4`,
        [
          encryptWith(newEncKey, plainPhone),
          hmacIndexWith(newHmacKey, plainPhone),
          plainEmail ? encryptWith(newEncKey, plainEmail) : null,
          row.id,
        ]
      );
      rotated++;
    }

    await client.query("COMMIT");
    console.log(`Key rotation complete. Rotated: ${rotated}, Skipped: ${skipped}`);
    console.log(
      "Next step: set PII_ENCRYPTION_KEY=<new_key> and PII_HMAC_KEY=<new_hmac> and redeploy."
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[rotate] Transaction rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Key rotation failed:", err);
  process.exit(1);
});
