/**
 * Credential input rules for phone + password auth. Pure and deterministic so the engine
 * (AuthService) and the HTTP layer can share one source of truth. Phone normalization is
 * handled by `normalizeMsisdn` (see payments.ts); these helpers cover password strength and
 * the public display username (which is unique and shown in chat/feed).
 */
/**
 * Four, because the people this product serves type it on a phone keypad, often repeatedly, and an
 * eight-character password with a letter and a digit was costing more signups than it was buying
 * security. A PIN is the deliberate trade.
 *
 * What makes that trade survivable is NOT the password: it is the throttle in front of it
 * (`rateLimit` on /auth/login, RATE_LIMIT_AUTH_PER_MIN) and the fact that a session is bound to one
 * brand. Four digits is 10,000 possibilities, so the throttle is now the ONLY thing standing between
 * an account and an exhaustive search — treat it as a security control, not a nicety, and do not
 * raise its limit without replacing it with per-account lockout.
 */
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128; // cap input to bound hashing cost (DoS guard)
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** alphanumeric, with single internal dots/underscores; must start & end alphanumeric. */
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._]*[a-zA-Z0-9])?$/;

export interface CredentialCheck { ok: boolean; reason?: string }

/**
 * Validate a password: LENGTH ONLY.
 *
 * No character classes. "1234" is accepted, and so is every password that was valid before — the
 * floor moved down, so no existing credential stops working and nobody is forced to reset.
 *
 * The maximum stays: it bounds scrypt's input and is a denial-of-service guard, not a strength rule.
 */
export function validatePassword(password: unknown): CredentialCheck {
  if (typeof password !== "string") return { ok: false, reason: "INVALID" };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "TOO_SHORT" };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, reason: "TOO_LONG" };
  return { ok: true };
}

/** Validate a public display username: length bounds + allowed charset. */
export function validateUsername(username: unknown): CredentialCheck {
  if (typeof username !== "string") return { ok: false, reason: "INVALID" };
  if (username.length < USERNAME_MIN_LENGTH) return { ok: false, reason: "TOO_SHORT" };
  if (username.length > USERNAME_MAX_LENGTH) return { ok: false, reason: "TOO_LONG" };
  if (!USERNAME_RE.test(username)) return { ok: false, reason: "INVALID_CHARS" };
  return { ok: true };
}

// Affiliate referral code: a public, shareable handle (not a secret), Crockford-style alphabet
// with no ambiguous characters (0/O, 1/I/L). The authoritative generator + uniqueness live in the
// DB RPC; this is the shared syntactic gate so the engine and HTTP layer reject malformed codes.
export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REFERRAL_CODE_LENGTH = 8;

export type ReferralCodeCheck = { ok: true; code: string } | { ok: false; reason: string };

/** Validate + normalize a referral code: trim, upper-case, exact length, allowed alphabet only. */
export function validateReferralCode(input: unknown): ReferralCodeCheck {
  if (typeof input !== "string") return { ok: false, reason: "INVALID" };
  const code = input.trim().toUpperCase();
  if (code.length !== REFERRAL_CODE_LENGTH) return { ok: false, reason: "INVALID_LENGTH" };
  for (const ch of code) if (!REFERRAL_CODE_ALPHABET.includes(ch)) return { ok: false, reason: "INVALID_CHARS" };
  return { ok: true, code };
}
