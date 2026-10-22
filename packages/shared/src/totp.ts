import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238 / HOTP RFC 4226) for administrative multi-factor auth. Pure and deterministic
 * given a secret + timestamp, so it unit-tests without a clock or network, and dependency-free
 * (node:crypto only) to keep the supply chain small for a security-critical primitive.
 *
 * Secrets are base32 (RFC 4648, no padding) because that is what authenticator apps and the
 * `otpauth://` URI scheme expect. Codes are compared in constant time across a small clock-skew
 * window so verification cannot be used as a timing oracle.
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32-encode (RFC 4648, unpadded) — the encoding authenticator apps expect for secrets. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32-decode (RFC 4648). Ignores padding/whitespace/case; throws on invalid characters. */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("INVALID_BASE32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit base32 secret (the RFC 4226 recommended key length for HMAC-SHA1). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP: the `digits`-length code for a specific counter value. */
export function hotpCode(secretB32: string, counter: number, digits = 6): string {
  const key = base32Decode(secretB32);
  if (key.length === 0) throw new Error("INVALID_SECRET");
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions { nowMs?: number; stepSeconds?: number; digits?: number; }

/** The current TOTP code for a secret (counter = floor(unix_seconds / step)). */
export function totpCode(secretB32: string, opts: TotpOptions = {}): string {
  const step = opts.stepSeconds ?? 30;
  const now = opts.nowMs ?? Date.now();
  return hotpCode(secretB32, Math.floor(now / 1000 / step), opts.digits ?? 6);
}

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a submitted code against the secret, tolerating `window` steps of clock skew on either
 * side (default ±1 step = ±30s). Comparison is constant time; non-numeric input fails closed.
 */
export function verifyTotp(secretB32: string, code: string, opts: TotpOptions & { window?: number } = {}): boolean {
  return matchTotpStep(secretB32, code, opts) !== null;
}

/**
 * Like `verifyTotp`, but returns WHICH time-step matched (the HOTP counter), or null for no match.
 *
 * The step is what makes a code single-use. `verifyTotp` answering only yes/no means a caller
 * cannot record what it just accepted, so the same code stays valid for the whole ±1-step window —
 * about 90 seconds. At login that is a minor matter. In front of "approve this M-Pesa payout" it is
 * not: a code glimpsed over a shoulder, screenshotted, or captured by a phishing page can be
 * replayed inside its window to authorise a second action the operator never approved. Pair this
 * with a persisted high-water mark (`IdentityRepository.consumeTotpStep`, migration 0196) and each
 * code works exactly once.
 *
 * Keeps the no-early-exit property of the original: every step in the window is computed and
 * compared whether or not an earlier one matched, so the time taken does not reveal which step
 * (and therefore how far the client's clock is from the server's). Returning the LAST match rather
 * than the first is deliberate — breaking out early is precisely the optimisation that would
 * reintroduce the timing signal.
 */
export function matchTotpStep(
  secretB32: string, code: string, opts: TotpOptions & { window?: number } = {},
): number | null {
  const digits = opts.digits ?? 6;
  const candidate = String(code ?? "").replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;
  const step = opts.stepSeconds ?? 30;
  const window = opts.window ?? 1;
  const counter = Math.floor((opts.nowMs ?? Date.now()) / 1000 / step);
  let matched: number | null = null;
  for (let drift = -window; drift <= window; drift += 1) {
    // No early exit: keep the work (and timing) uniform across the whole window.
    if (safeEqual(hotpCode(secretB32, counter + drift, digits), candidate)) matched = counter + drift;
  }
  return matched;
}

/** The `otpauth://` provisioning URI an authenticator app scans (rendered as a QR code). */
export function otpauthUrl(args: { secret: string; account: string; issuer: string; digits?: number; stepSeconds?: number }): string {
  const label = `${encodeURIComponent(args.issuer)}:${encodeURIComponent(args.account)}`;
  const q = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: "SHA1",
    digits: String(args.digits ?? 6),
    period: String(args.stepSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * Single-use recovery codes for when the authenticator device is lost. Returned to the operator
 * exactly once at enrolment; only their hashes are stored (hashing is the caller's job so this
 * module stays pure).
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 10 base32 chars (~50 bits) split for legibility, e.g. "K7QF2-9ZTMR".
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

/** Normalize a recovery code for hashing/compare (case- and dash-insensitive). */
export function normalizeRecoveryCode(code: string): string {
  return String(code ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}
