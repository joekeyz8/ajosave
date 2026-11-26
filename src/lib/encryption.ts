/**
 * PII Encryption Utilities — Issue #138
 *
 * Provides AES-256-GCM authenticated encryption for PII fields (phone, email)
 * and HMAC-SHA256 blind-index helpers so encrypted values remain searchable.
 *
 * Environment variables required:
 *   PII_ENCRYPTION_KEY  — 64 hex chars (32 bytes), used for AES-256-GCM
 *   PII_HMAC_KEY        — 64 hex chars (32 bytes), used for HMAC-SHA256 indexes
 *
 * Generate both with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const TAG_BYTES = 16;
const ENCODING = "base64url" as const;

/**
 * Thrown when AES-256-GCM tag verification fails (key mismatch or tampered ciphertext).
 * Callers should NOT swallow this — surface a 500 response and alert operations.
 */
export class PiiDecryptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiiDecryptionError";
  }
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const TAG_BYTES = 16;
const ENCODING = "base64url" as const;

function getEncryptionKey(): Buffer {
  const hex = process.env.PII_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("PII_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function getHmacKey(): Buffer {
  const hex = process.env.PII_HMAC_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("PII_HMAC_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a compact "<iv>.<ciphertext>.<tag>" base64url string.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((b) => b.toString(ENCODING)).join(".");
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Throws if the authentication tag is invalid (tamper detection).
 * Never returns null silently — callers must handle the thrown error and surface a 500.
 */
export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload format");
  const [ivB64, ciphertextB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, ENCODING);
  const ciphertext = Buffer.from(ciphertextB64, ENCODING);
  const tag = Buffer.from(tagB64, ENCODING);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    // Surface to Sentry / alerting pipelines via a named error class
    const err = new PiiDecryptionError(
      `AES-256-GCM authentication tag verification failed — possible key mismatch or data tampering`,
      { cause }
    );
    // Best-effort: emit to stderr so log aggregation picks it up without leaking ciphertext
    console.error("[encryption] ALERT: decryption failure", { error: err.message });
    throw err;
  }
}

/**
 * Compute a deterministic HMAC-SHA256 blind index for a plaintext value.
 * Use this in WHERE clauses instead of the raw plaintext.
 * Returns a 44-char base64url string.
 */
export function hmacIndex(value: string): string {
  return createHmac("sha256", getHmacKey()).update(value, "utf8").digest(ENCODING);
}

/**
 * Constant-time comparison of two HMAC indexes to prevent timing attacks.
 */
export function hmacIndexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
