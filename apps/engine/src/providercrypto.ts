/**
 * providercrypto.ts — application-level encryption for payment-gateway secrets (migration 0130).
 *
 * Gateway credentials (api keys, secrets, basic-auth tokens) are encrypted HERE, in the engine,
 * with AES-256-GCM before they are written to Postgres. The DB only ever stores ciphertext; the
 * 32-byte key lives in the `PAYMENTS_CONFIG_ENC_KEY` env secret (a Fly secret in prod) and NEVER in
 * the database — so a DB dump alone cannot reveal a single credential (defence in depth).
 *
 * Wire format (base64):  [ iv(12 bytes) | ciphertext | authTag(16 bytes) ]
 * GCM gives us confidentiality AND tamper-detection: a modified ciphertext fails `decrypt` loudly
 * rather than returning garbage that could be mistaken for a real credential.
 *
 * The key is accepted as base64 (44 chars) or hex (64 chars) and MUST decode to exactly 32 bytes.
 * When the key is absent we FAIL LOUDLY on any encrypt/decrypt attempt — we never fall back to
 * storing a plaintext secret, and `isEncryptionConfigured()` lets callers surface a clear setup error.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const CURRENT_ENC_VERSION = 1;

/** Per-field masked hint stored alongside the ciphertext for the console (never the secret itself). */
export interface SecretMeta { set: boolean; last4: string }
export interface EncryptResult { ciphertext: string; meta: Record<string, SecretMeta>; encVersion: number }

/** Default key source (payments). Registrar config passes its own preference list (see registrarconfig). */
export const DEFAULT_ENC_KEY_VARS: readonly string[] = ["PAYMENTS_CONFIG_ENC_KEY"];

/** Parse the env key (base64 or hex) into exactly 32 bytes, or null when unset/malformed. Tries each
 *  name in `varNames` in order (first configured, valid key wins) — lets a feature use a dedicated key
 *  (e.g. REGISTRAR_CONFIG_ENC_KEY) while falling back to the shared PAYMENTS_CONFIG_ENC_KEY. */
export function loadEncKey(env: NodeJS.ProcessEnv = process.env, varNames: readonly string[] = DEFAULT_ENC_KEY_VARS): Buffer | null {
  for (const name of varNames) {
    const raw = (env[name] ?? "").trim();
    if (!raw) continue;
    let buf: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
    else {
      try { const b = Buffer.from(raw, "base64"); if (b.length === KEY_BYTES) buf = b; } catch { /* fallthrough */ }
    }
    if (buf && buf.length === KEY_BYTES) return buf;
  }
  return null;
}

export function isEncryptionConfigured(env: NodeJS.ProcessEnv = process.env, varNames: readonly string[] = DEFAULT_ENC_KEY_VARS): boolean {
  return loadEncKey(env, varNames) !== null;
}

/** Last 4 chars of a secret for masked display; short secrets are fully masked (no partial leak of tiny keys). */
export function last4(value: string): string {
  const v = String(value ?? "");
  return v.length >= 8 ? v.slice(-4) : ""; // never reveal >half of a short secret
}

/**
 * Encrypt a map of secret fields into one ciphertext blob + per-field masked meta. Empty/blank
 * values are dropped (we do not persist empty secrets). Returns null ciphertext when there is
 * nothing to store, so the caller can pass '' to CLEAR or leave the stored secret untouched.
 */
export function encryptSecrets(
  secrets: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  varNames: readonly string[] = DEFAULT_ENC_KEY_VARS,
): EncryptResult {
  const key = loadEncKey(env, varNames);
  if (!key) throw new Error("ENC_KEY_NOT_CONFIGURED");
  const clean: Record<string, string> = {};
  const meta: Record<string, SecretMeta> = {};
  for (const [k, v] of Object.entries(secrets)) {
    const val = typeof v === "string" ? v.trim() : "";
    if (!val) continue;
    clean[k] = val;
    meta[k] = { set: true, last4: last4(val) };
  }
  if (Object.keys(clean).length === 0) return { ciphertext: "", meta: {}, encVersion: CURRENT_ENC_VERSION };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(clean), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, ct, tag]).toString("base64"), meta, encVersion: CURRENT_ENC_VERSION };
}

/** Decrypt a ciphertext blob back into the secret-field map. Throws on tamper/wrong-key/bad-format. */
export function decryptSecrets(
  ciphertext: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  varNames: readonly string[] = DEFAULT_ENC_KEY_VARS,
): Record<string, string> {
  if (!ciphertext) return {};
  const key = loadEncKey(env, varNames);
  if (!key) throw new Error("ENC_KEY_NOT_CONFIGURED");
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error("ENC_CIPHERTEXT_MALFORMED");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  const obj = JSON.parse(pt) as Record<string, string>;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("ENC_PAYLOAD_INVALID");
  return obj;
}
