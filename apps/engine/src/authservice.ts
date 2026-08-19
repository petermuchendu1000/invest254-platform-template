import { randomBytes, scrypt as _scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { SignJWT } from "jose";
import { validatePassword, validateUsername, validateReferralCode, normalizeMsisdn,
  generateTotpSecret, verifyTotp, otpauthUrl, generateRecoveryCodes, normalizeRecoveryCode } from "@invest254/shared";
import type { IdentityRepository, MfaRecord, CredentialRecord } from "./identity.js";

/**
 * AuthService — self-managed phone + password authentication (no OTP, no Supabase Auth).
 * Hashes with scrypt (timing-safe verify) and self-issues HS256 JWTs signed with the same
 * secret the engine's `makeVerifier` already checks (SUPABASE_JWT_SECRET), so every existing
 * authenticated route/WS keeps working unchanged. Money/identity correctness (atomic insert,
 * uniqueness, RLS lockdown) lives in the migration-0015 RPC behind IdentityRepository; this
 * layer adds input validation, hashing, the login status gate, and anti-enumeration.
 */

/** Promise wrapper around node's scrypt that accepts the cost options (the promisify overload drops them). */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk as Buffer)));
  });
}

// scrypt cost: N=2^15, r=8, p=1 -> 32-byte key from a 16-byte random salt. 128*N*r bytes
// of memory (~33.5 MB) requires a raised maxmem ceiling.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const SALTLEN = 16;
const MAXMEM = 64 * 1024 * 1024;
const SCHEME = "scrypt";

/** Hash a password -> `scrypt$N$r$p$salt_b64$hash_b64` (self-describing so cost can be re-tuned later). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALTLEN);
  const dk = (await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM })) as Buffer;
  return `${SCHEME}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

/** Constant-time verify against a stored `scrypt$...` hash. Returns false on any malformed input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 2 || r < 1 || p < 1) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  let dk: Buffer;
  try { dk = (await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM })) as Buffer; }
  catch { return false; }
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

/** A successful authentication: a signed token plus the verified identity. */
export interface AuthSession { token: string; userId: string; role: string; site?: string; mfaEnrolmentRequired?: boolean; }

/** Profile view returned by `/me`. */
export interface Profile {
  userId: string; username: string; phone: string; role: string; status: string;
}

export interface AuthServiceOptions {
  /** HS256 signing secret. Use the same value as SUPABASE_JWT_SECRET so makeVerifier accepts the token. */
  jwtSecret: string;
  /** Token lifetime in seconds (default 7 days). */
  jwtTtlSeconds?: number;
  /** Optional issuer/audience; set them to match the engine's verifier options. */
  issuer?: string;
  audience?: string;
  /** Roles that must use TOTP MFA (default: admin + superadmin). */
  mfaRequiredRoles?: readonly string[];
  /** Issuer label shown in the operator's authenticator app. */
  mfaIssuer?: string;
  /**
   * Allow `resetPassword` to set a new password from a phone number alone (no OTP/possession
   * proof). This is account takeover by design, so it defaults to FALSE and must be switched on
   * deliberately. Remove once OTP verification ships.
   */
  allowUnverifiedPasswordReset?: boolean;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

// A real scrypt hash of a throwaway secret, verified against when the phone is unknown so a
// failed login costs the same whether or not the account exists (anti-enumeration).
const DUMMY_HASH = hashPassword(randomBytes(24).toString("hex"));

export class AuthService {
  private readonly secret: Uint8Array;
  private readonly ttl: number;
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;
  private readonly mfaRoles: ReadonlySet<string>;
  private readonly mfaIssuer: string;
  private readonly allowUnverifiedReset: boolean;

  constructor(private readonly repo: IdentityRepository, opts: AuthServiceOptions) {
    if (!opts.jwtSecret) throw new Error("JWT_SECRET_REQUIRED");
    this.secret = new TextEncoder().encode(opts.jwtSecret);
    this.ttl = opts.jwtTtlSeconds ?? DEFAULT_TTL_SECONDS;
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.mfaRoles = new Set(opts.mfaRequiredRoles ?? ["admin", "superadmin"]);
    this.mfaIssuer = opts.mfaIssuer ?? "Invest254";
    this.allowUnverifiedReset = opts.allowUnverifiedPasswordReset ?? false;
  }

  /** Sign an HS256 JWT compatible with makeVerifier (sub = userId, `role` + optional `site` claims). */
  async issueToken(userId: string, role: string, siteId?: string): Promise<string> {
    const claims: Record<string, unknown> = { role };
    if (siteId) claims.site = siteId; // multi-tenant: binds the token to a brand
    let b = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(userId)
      .setIssuedAt().setExpirationTime(`${this.ttl}s`);
    if (this.issuer) b = b.setIssuer(this.issuer);
    if (this.audience) b = b.setAudience(this.audience);
    return b.sign(this.secret);
  }

  /**
   * Register a new player: validate -> normalize phone -> hash -> atomic insert -> issue token.
   * An optional referral code is syntactically validated here (malformed -> INVALID_REFERRAL_CODE)
   * and passed through normalized; resolving it to an active affiliate (first-touch attribution)
   * happens atomically inside the register RPC, where an unknown/suspended code is ignored.
   */
  async register(input: { phone: string; username: string; password: string; referralCode?: string; siteId?: string }): Promise<AuthSession> {
    const pw = validatePassword(input.password);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    const un = validateUsername(input.username);
    if (!un.ok) throw new Error(`USERNAME_${un.reason}`);
    const phone = normalizeMsisdn(input.phone); // throws INVALID_PHONE on bad input
    let referralCode: string | undefined;
    if (input.referralCode !== undefined && input.referralCode !== "") {
      const rc = validateReferralCode(input.referralCode);
      if (!rc.ok) throw new Error("INVALID_REFERRAL_CODE");
      referralCode = rc.code;
    }
    const hash = await hashPassword(input.password);
    const { userId, role } = await this.repo.register(phone, input.username, hash, referralCode, input.siteId);
    const token = await this.issueToken(userId, role, input.siteId);
    return { token, userId, role, ...(input.siteId ? { site: input.siteId } : {}) };
  }

  /**
   * Log in: normalize -> constant-time verify -> active-status gate -> second factor -> token.
   * Once an account has MFA enabled a valid `totp` (or a single-use `recoveryCode`) is mandatory.
   * Privileged roles that have not enrolled yet are still admitted but flagged with
   * `mfaEnrolmentRequired` so enabling MFA can never lock an operator out of their own back office.
   */
  async login(input: { phone: string; password: string; totp?: string; recoveryCode?: string; siteId?: string; anyBrand?: boolean }): Promise<AuthSession> {
    let phone: string;
    try { phone = normalizeMsisdn(input.phone); } catch { throw new Error("INVALID_CREDENTIALS"); }

    // Candidate set:
    //  - siteId given (the web, which knows its brand from the host) -> scope to that brand.
    //  - anyBrand (the marketer apps: one generic build that CANNOT know the marketer's brand, and
    //    send no site) -> every brand's account on this phone; the PASSWORD then identifies which
    //    brand's account is signing in, and its brand becomes the session's site. This is OPT-IN so
    //    it never weakens the default per-brand identity isolation of the normal web login.
    //  - otherwise (default) -> the legacy single lookup (scoped/default bucket): brand isolation.
    const candidates = input.anyBrand && !input.siteId
      ? await this.repo.findAllByPhone(phone)
      : await this.repo.findByPhone(phone, input.siteId).then((r) => (r ? [r] : []));

    // Constant-ish time + anti-enumeration: verify against each candidate; if none exist, still run
    // one verify against a dummy hash so a bad phone costs the same as a bad password.
    let rec: CredentialRecord | null = null;
    if (candidates.length === 0) {
      await verifyPassword(input.password, await DUMMY_HASH);
    } else {
      for (const c of candidates) {
        if (await verifyPassword(input.password, c.passwordHash)) { rec = c; break; }
      }
    }
    if (!rec) throw new Error("INVALID_CREDENTIALS");
    // Account status does NOT gate login. A limited/suspended/banned player can still sign in
    // so they can DEPOSIT and see their balance. Trading and withdrawal are gated separately at
    // the money layer (fn_open_position / fn_create_withdrawal reject a non-active account), so a
    // limited account can top up but cannot open new trades or cash out. Deposits stay open.
    const mfa = await this.repo.getMfa(rec.userId);
    if (mfa?.enabled) await this.assertSecondFactor(rec.userId, mfa, input.totp, input.recoveryCode);
    // The brand is the matched account's own site (falling back to an explicit siteId for the web).
    const resolvedSite = input.siteId ?? rec.siteId ?? undefined;
    const token = await this.issueToken(rec.userId, rec.role, resolvedSite);
    const needsEnrolment = this.mfaRoles.has(rec.role) && !mfa?.enabled;
    const site = resolvedSite ? { site: resolvedSite } : {};
    return needsEnrolment
      ? { token, userId: rec.userId, role: rec.role, mfaEnrolmentRequired: true, ...site }
      : { token, userId: rec.userId, role: rec.role, ...site };
  }

  /**
   * Verify the second factor: a live TOTP code, or burn one single-use recovery code. Throws
   * MFA_REQUIRED when nothing was supplied and MFA_INVALID when it doesn't check out (the same
   * error for a bad code and a spent one, so neither reveals which).
   */
  private async assertSecondFactor(userId: string, mfa: MfaRecord, totp?: string, recoveryCode?: string): Promise<void> {
    if (totp) {
      if (!verifyTotp(mfa.secret, totp)) throw new Error("MFA_INVALID");
      return;
    }
    if (recoveryCode) {
      const supplied = normalizeRecoveryCode(recoveryCode);
      for (const hash of mfa.recoveryCodeHashes) {
        if (await verifyPassword(supplied, hash)) {
          if (await this.repo.consumeRecoveryCode(userId, hash)) return; // single use
          break; // already spent concurrently
        }
      }
      throw new Error("MFA_INVALID");
    }
    throw new Error("MFA_REQUIRED");
  }

  /**
   * Begin (or restart) TOTP enrolment. Returns the base32 secret, the `otpauth://` URI to render
   * as a QR code, and freshly minted recovery codes. The recovery codes are shown EXACTLY once —
   * only scrypt hashes are stored — and MFA stays disabled until `confirmMfa` proves the operator
   * can generate a live code, so a mis-scanned secret can't lock them out.
   */
  async beginMfaEnrolment(userId: string): Promise<{ secret: string; otpauthUrl: string; recoveryCodes: string[] }> {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new Error("NOT_FOUND");
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(normalizeRecoveryCode(c))));
    await this.repo.putMfaSecret(userId, secret, hashes);
    return { secret, otpauthUrl: otpauthUrl({ secret, account: profile.phone, issuer: this.mfaIssuer }), recoveryCodes };
  }

  /** Confirm enrolment with a live code -> MFA enforced from the next login. Throws MFA_INVALID. */
  async confirmMfa(userId: string, code: string): Promise<{ enabled: boolean }> {
    const mfa = await this.repo.getMfa(userId);
    if (!mfa) throw new Error("MFA_NOT_ENROLLING");
    if (!verifyTotp(mfa.secret, code)) throw new Error("MFA_INVALID");
    await this.repo.enableMfa(userId);
    return { enabled: true };
  }

  /** Disable MFA — requires a current TOTP or recovery code to prove device possession. */
  async disableMfa(userId: string, code: string): Promise<{ enabled: boolean }> {
    const mfa = await this.repo.getMfa(userId);
    if (!mfa?.enabled) { await this.repo.disableMfa(userId); return { enabled: false }; }
    const looksTotp = /^\d{6}$/.test(String(code ?? "").trim());
    await this.assertSecondFactor(userId, mfa, looksTotp ? code : undefined, looksTotp ? undefined : code);
    await this.repo.disableMfa(userId);
    return { enabled: false };
  }

  /** MFA state for the caller: enabled, remaining recovery codes, and whether their role requires it. */
  async mfaStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number; required: boolean }> {
    const [mfa, profile] = await Promise.all([this.repo.getMfa(userId), this.repo.getProfile(userId)]);
    return {
      enabled: Boolean(mfa?.enabled),
      recoveryCodesLeft: mfa?.recoveryCodeHashes.length ?? 0,
      required: Boolean(profile && this.mfaRoles.has(profile.role)),
    };
  }

  /**
   * Change your own password. Requires the current password as possession proof, so this is safe
   * to expose to every logged-in player and is always enabled.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ changed: boolean }> {
    const pw = validatePassword(newPassword);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new Error("NOT_FOUND");
    const rec = await this.repo.findByPhone(profile.phone);
    if (!rec || !(await verifyPassword(currentPassword, rec.passwordHash))) throw new Error("INVALID_CREDENTIALS");
    await this.repo.setPasswordHash(userId, await hashPassword(newPassword));
    return { changed: true };
  }

  /**
   * Set a new password from a phone number alone — no OTP, no possession proof.
   *
   * ⚠️  SECURITY: with nothing to prove the caller owns the number this IS account takeover:
   * anyone who knows a player's phone can seize their wallet. It therefore throws
   * RESET_DISABLED unless `allowUnverifiedPasswordReset` is explicitly turned on, and should be
   * replaced by an OTP-verified flow before real money is at stake.
   *
   * The response is identical whether or not the account exists (and the hash is computed either
   * way) so this cannot be used to enumerate registered phone numbers.
   */
  async resetPassword(phone: string, newPassword: string, siteId?: string): Promise<{ reset: boolean }> {
    if (!this.allowUnverifiedReset) throw new Error("RESET_DISABLED");
    const pw = validatePassword(newPassword);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    let normalized: string;
    try { normalized = normalizeMsisdn(phone); } catch { throw new Error("INVALID_PHONE"); }
    // Scope to the caller's brand so a phone shared across brands can't cross-reset the wrong
    // account. Undefined siteId preserves single-tenant behaviour (default site).
    const rec = await this.repo.findByPhone(normalized, siteId);
    const hash = await hashPassword(newPassword); // computed unconditionally: uniform timing
    if (rec) await this.repo.setPasswordHash(rec.userId, hash);
    return { reset: true };
  }

  /** Read the caller's profile. Throws NOT_FOUND if no such identity. */  async me(userId: string): Promise<Profile> {
    const p = await this.repo.getProfile(userId);
    if (!p) throw new Error("NOT_FOUND");
    return p;
  }
}
