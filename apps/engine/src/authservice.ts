import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { SignJWT } from "jose";
import { validatePassword, validateUsername, validateReferralCode, normalizeMsisdn,
  generateTotpSecret, verifyTotp, matchTotpStep, otpauthUrl, generateRecoveryCodes, normalizeRecoveryCode,
  normalizeSecurityAnswer, validateSecurityAnswerSet, isValidSecurityQuestionKey,
  SECURITY_ANSWERS_REQUIRED, SECURITY_QUESTIONS } from "@invest254/shared";
import type { IdentityRepository, MfaRecord, CredentialRecord, SecurityAnswerHash } from "./identity.js";

/**
 * Roles for which a password reset is a knowledge-second-factor gate (0097). These accounts run the
 * back office (approve withdrawals, adjust balances, change RTP), so a phone-only reset is account
 * takeover. The role set is player/marketer/admin/platform_admin/platform_superadmin — the legacy
 * per-brand `superadmin` tier was removed in Issue 1 / F1 (migration 0152).
 */
export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set([
  "admin", "platform_admin", "platform_superadmin",
]);

/** True when `role` is an administrative role gated by the security-question second factor. */
export function isPrivilegedRole(role: string | undefined | null): boolean {
  return typeof role === "string" && PRIVILEGED_ROLES.has(role);
}

/**
 * Roles whose session is FORCE-LOGOUT checked on every request (0097 epoch + migration 0200).
 *
 * Deliberately WIDER than PRIVILEGED_ROLES, and a separate set on purpose: `marketer` must be
 * revocable because marketers demo the platform on LIVE STREAMS, so "sign every marketer out now"
 * has to actually end their WEBSITE session — not just the till-app one. 0198 added the epoch to the
 * `public.marketers` identity (token subject = marketers.id, gated in requireMarketer), but a marketer
 * signed in to the website holds a `profiles` token with role='marketer', and assertSessionValid
 * skipped it entirely because 'marketer' is not privileged — so profiles.sessions_valid_after was
 * never even read and the force-logout silently did nothing for them.
 *
 * It is NOT folded into PRIVILEGED_ROLES because that set also drives the password-reset
 * knowledge-factor gate and the MFA requirement; a marketer must stay a non-privileged account there.
 * Players are still excluded, so the high-volume path keeps skipping the DB read. This gate is only
 * the force-logout epoch — the 0196 five-minute IDLE timeout stays operator-only, since logging a
 * marketer out mid-demo every five minutes would be worse than the problem.
 */
export const SESSION_GATED_ROLES: ReadonlySet<string> = new Set([...PRIVILEGED_ROLES, "marketer"]);

/** True when `role`'s token must be checked against the account's force-logout epoch. */
export function isSessionGatedRole(role: string | undefined | null): boolean {
  return typeof role === "string" && SESSION_GATED_ROLES.has(role);
}

/**
 * Pure force-logout check (0097): is a token issued at `iatSeconds` (standard JWT `iat`, seconds)
 * still valid given the account's force-logout epoch `sessionsValidAfterMs` (ms, or null)? A token
 * issued strictly before the epoch is revoked. Exported so it can be unit-tested in isolation.
 */
export function isTokenSessionValid(iatSeconds: number | undefined, sessionsValidAfterMs: number | null): boolean {
  if (sessionsValidAfterMs == null) return true;                 // never force-logged-out
  if (typeof iatSeconds !== "number" || !Number.isFinite(iatSeconds)) return false; // no iat → fail closed
  return iatSeconds * 1000 >= sessionsValidAfterMs;
}

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
export interface AuthSession { token: string; userId: string; role: string; site?: string; platform?: string; mfaEnrolmentRequired?: boolean;
  /** Cents credited by the one-time sign-up welcome bonus (0094). Present on register only when > 0. */
  welcomeBonusCents?: number; }

/** Profile view returned by `/me`. */
export interface Profile {
  userId: string; username: string; phone: string; role: string; status: string;
  /** Live scope (profiles.site_id / profiles.platform_id) — see issueSessionToken. */
  siteId?: string | null; platformId?: string | null;
}

/** A freshly minted session token plus the scope it carries. */
export interface ScopedSession { token: string; role: string; site?: string; platform?: string; }

export interface AuthServiceOptions {
  /** HS256 signing secret. Use the same value as SUPABASE_JWT_SECRET so makeVerifier accepts the token. */
  jwtSecret: string;
  /** Token lifetime in seconds (default 7 days). */
  jwtTtlSeconds?: number;
  /** Optional issuer/audience; set them to match the engine's verifier options. */
  issuer?: string;
  audience?: string;
  /** Roles that must use TOTP MFA (default: admin + platform_admin + platform_superadmin). */
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

/**
 * Progressive login lockout (0197). `[failuresAtOrAbove, lockMs]`, applied highest-match-first.
 *
 * The control this replaces is a 40/minute counter keyed on the CALLER'S IP, held in one API
 * process. With PASSWORD_MIN_LENGTH at 4 and no character classes, a password can be one of 10,000
 * values; an attacker spread over a /24 never trips a per-IP bucket, and a deploy resets every
 * bucket anyway. credentials.ts says so in as many words: the throttle "is now the ONLY thing
 * standing between an account and an exhaustive search ... do not raise its limit without replacing
 * it with per-account lockout." This is that lockout.
 *
 * Shaped so the attacker's cost grows and the honest user's does not:
 *   - the first four failures cost nothing at all, so a fumbled password is never punished;
 *   - from the fifth the delay climbs steeply, and a successful login clears the streak outright.
 * Against 10,000 candidates the schedule is decisive: reaching even a thousand attempts costs days.
 *
 * It is deliberately NOT a flat 15-minute lock like the marketer PIN's (0034). A flat lock makes
 * denial cheap and repeatable — five deliberate wrong passwords and a brand's admin cannot reach
 * their own back office, which on this platform means nobody is approving withdrawals. Starting at
 * 30 seconds keeps that attack expensive to sustain while still stopping a search dead.
 */
const LOCKOUT_SCHEDULE: ReadonlyArray<readonly [number, number]> = [
  [25, 60 * 60_000],   // 25+ failures: an hour. Nobody mistypes a password 25 times.
  [15, 15 * 60_000],
  [10, 5 * 60_000],
  [7, 60_000],
  [5, 30_000],         // first lock, deliberately short
];

/**
 * A failure streak older than this is forgotten, so a lock cannot be assembled from single failures
 * weeks apart. Long enough to cover a real attack's pace, short enough that an honest mistake last
 * month does not count against someone today.
 */
const LOCKOUT_STREAK_TTL_MS = 12 * 60 * 60_000;

/** The lock a given failure count earns; 0 = no lock. Exported for test and for the comment above. */
export function lockMsForFailures(failures: number): number {
  for (const [threshold, ms] of LOCKOUT_SCHEDULE) if (failures >= threshold) return ms;
  return 0;
}

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
    this.mfaRoles = new Set(opts.mfaRequiredRoles ?? ["admin", "platform_admin", "platform_superadmin"]);
    this.mfaIssuer = opts.mfaIssuer ?? "Invest254";
    this.allowUnverifiedReset = opts.allowUnverifiedPasswordReset ?? false;
  }

  /**
   * THE choke point for re-minting a session for an existing account (Issue 1 / F-43, invariant S1:
   * "every token carries its holder's scope"). Reads the LIVE profile and stamps role + `site` +
   * (platform_admin) `platform`, exactly as login does. Re-mint paths (token refresh after a role
   * change, affiliate enrolment) MUST use this instead of `issueToken(userId, role)`: dropping the
   * claims turned a site admin into an unrestricted, every-brand admin (adminScopeSite: missing
   * site => null => unrestricted), and a platform admin into a locked-out claimless token.
   * Throws NOT_FOUND for an unknown account.
   */
  async issueSessionToken(userId: string): Promise<ScopedSession> {
    const p = await this.repo.getProfile(userId);
    if (!p) throw new Error("NOT_FOUND");
    const site = p.siteId ?? undefined;
    const platform = p.platformId ?? undefined;
    const token = await this.issueToken(userId, p.role, site, platform);
    return { token, role: p.role, ...(site ? { site } : {}), ...(platform ? { platform } : {}) };
  }

  /** Sign an HS256 JWT compatible with makeVerifier (sub = userId, `role` + optional `site` claims).
   *  `act` (docs/42 UI-3, modelled on RFC 8693's actor claim) marks an IMPERSONATION token: who is really
   *  acting (their own tier) and the brand opened. It travels with the token, so every tab — not just the
   *  one that started it — knows the session is an impersonation, and nothing "heals" it back to the
   *  actor's own token by accident. Authorisation never reads it: the API still authorises `role`/`site`. */
  async issueToken(userId: string, role: string, siteId?: string, platformId?: string,
    act?: { sub: string; role: string; brand?: string }): Promise<string> {
    const claims: Record<string, unknown> = { role };
    if (siteId) claims.site = siteId; // multi-tenant: binds the token to a brand
    if (platformId) claims.platform = platformId; // platform tier: binds a platform_admin to its platform (Issue 1)
    if (act) claims.act = { sub: act.sub, role: act.role, ...(act.brand ? { brand: act.brand } : {}) };
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
    // One-time welcome bonus (0094). Idempotent + config-aware in the DB, so a transient failure here
    // never blocks sign-up and can be safely retried; we surface the credited amount so the client can
    // celebrate it with the winning-card animation.
    let welcomeBonusCents = 0;
    try { welcomeBonusCents = await this.repo.grantWelcomeBonus(userId); }
    catch { welcomeBonusCents = 0; /* non-fatal: registration already succeeded */ }
    return { token, userId, role, ...(input.siteId ? { site: input.siteId } : {}),
      ...(welcomeBonusCents > 0 ? { welcomeBonusCents } : {}) };
  }

  /**
   * Log in: normalize -> constant-time verify -> active-status gate -> second factor -> token.
   * Once an account has MFA enabled a valid `totp` (or a single-use `recoveryCode`) is mandatory.
   * Privileged roles that have not enrolled yet are still admitted but flagged with
   * `mfaEnrolmentRequired` so enabling MFA can never lock an operator out of their own back office.
   */
  async login(input: { phone: string; password: string; totp?: string; recoveryCode?: string; siteId?: string; anyBrand?: boolean; preferPrivileged?: boolean }): Promise<AuthSession> {
    let phone: string;
    try { phone = normalizeMsisdn(input.phone); } catch { throw new Error("INVALID_CREDENTIALS"); }

    // Candidate set:
    //  - siteId given (the web, which knows its brand from the host) -> scope to that brand.
    //  - anyBrand (the marketer apps: one generic build that CANNOT know the marketer's brand, and
    //    send no site) -> every brand's account on this phone; the PASSWORD then identifies which
    //    brand's account is signing in, and its brand becomes the session's site. This is OPT-IN so
    //    it never weakens the default per-brand identity isolation of the normal web login.
    //  - otherwise (default) -> the legacy single lookup (scoped/default bucket): brand isolation.
    //
    // `preferPrivileged` then decides WHICH match wins when several do — see the scan below. It is
    // passed by the operator sign-in alone, so the marketer apps' anyBrand login is untouched (a
    // marketer's wallet lives on one brand, and resolving them to an admin account they happen to
    // also own would send them to the wrong one).
    const candidates = input.anyBrand && !input.siteId
      ? await this.repo.findAllByPhone(phone)
      : await this.repo.findByPhone(phone, input.siteId).then((r) => (r ? [r] : []));

    // Constant-ish time + anti-enumeration: verify against each candidate; if none exist, still run
    // one verify against a dummy hash so a bad phone costs the same as a bad password.
    let rec: CredentialRecord | null = null;
    if (candidates.length === 0) {
      await verifyPassword(input.password, await DUMMY_HASH);
    } else {
      let verifiedAny = false;
      for (const c of candidates) {
        // A soft-DELETED account can never sign in (see below). In the anyBrand path a person may
        // hold several same-phone accounts across brands (the marketer apps), returned oldest-first;
        // a deleted account must NOT shadow a valid one it happens to precede — skip it so matching
        // continues to the caller's real account. (BUGLOG #31 — jake's deleted invest254 account
        // was blocking his active safitraders marketer login.)
        if (c.status === "deleted") continue;
        verifiedAny = true;
        if (await verifyPassword(input.password, c.passwordHash)) {
          // The first match is the answer, and on the default path it ends the scan — oldest-first,
          // exactly as before.
          if (!rec) rec = c;
          if (!input.preferPrivileged) break;
          // preferPrivileged (the OPERATOR entry point only): an operator candidate outranks a
          // non-operator one, whatever the ages. One person, one phone, two accounts — an older
          // PLAYER and a newer ADMIN — used to resolve to the player whenever both accounts shared
          // a password, because oldest-first took the first match and stopped. The operator was
          // handed a valid player session and every console surface answered with its wrong-tier
          // 404: "an admin who can't login anywhere, just 404" (BUGLOG #135). `created_at` is a
          // deterministic tie-break, which is not the same as a correct one.
          //
          // This cannot escalate anything. A candidate is only ever considered here after ITS OWN
          // hash verified the submitted password, so the password that wins the admin's session is
          // the admin's own. When the two accounts have different passwords, the player's password
          // matches only the player and still resolves to the player — there is a test for each
          // direction. And the same credential already opened this account through the per-brand
          // login on its own brand's host, so no new door is being opened; one that was shut on the
          // operator domain is being opened.
          if (isPrivilegedRole(c.role)) { rec = c; break; }
        }
      }
      // Constant time when every candidate was skipped (all-deleted phone): still cost one verify.
      if (!verifiedAny) await verifyPassword(input.password, await DUMMY_HASH);
    }
    // ── Progressive per-account lockout (0197) ──────────────────────────────────────────────────
    // Checked AFTER the password verification above, not before, and this ordering is the whole
    // trick. Refusing a locked account up front would make the lock itself an oracle: an attacker
    // probing a phone with any password would learn, from a LOCKED answer, that the account exists
    // and is being attacked — handing them the account-enumeration result that `login` goes to real
    // lengths (the dummy-hash verify above) to deny. So the password is always verified first, at
    // the same cost either way, and a locked account is then refused with the SAME
    // INVALID_CREDENTIALS a wrong password gives. The attacker learns nothing; the honest user is
    // told what happened by the retry-after their client already handles.
    //
    // The consequence to be clear about: a locked-out operator with the RIGHT password still cannot
    // get in until the lock lapses. That is the point of a lockout, and it is why the schedule
    // starts at 30 seconds rather than 15 minutes.
    const locked = rec && rec.lockedUntilMs != null && rec.lockedUntilMs > Date.now();
    if (!rec || locked) {
      // Count the failure against the account when we know which one it was. An unknown phone has
      // no row to count against — that is the IP limiter's job, not this one's.
      if (rec) await this.noteLoginFailure(rec);
      else if (candidates.length === 1) await this.noteLoginFailure(candidates[0]!);
      throw new Error("INVALID_CREDENTIALS");
    }
    // A soft-DELETED account is treated as if it does not exist: same error as bad credentials, so a
    // deleted user can never sign in and the deletion can't be enumerated. (suspended/banned still
    // sign in — see below — so deposits/support stay open; only 'deleted' is a hard login block.)
    if (rec.status === "deleted") throw new Error("INVALID_CREDENTIALS");
    // For a PLAYER/MARKETER, account status does NOT gate login: a limited/suspended/banned player can
    // still sign in so they can DEPOSIT and see their balance. Trading and withdrawal are gated
    // separately at the money layer (fn_open_position / fn_create_withdrawal reject a non-active
    // account), so a limited account can top up but cannot open new trades or cash out.
    //
    // But a PRIVILEGED account (operator) MUST be active to obtain a session (#7): a suspended/banned
    // admin can no longer sign in or mint a fresh admin token. There is no "deposits stay open"
    // rationale for an operator, and banning must actually remove their authority — not just their
    // status badge. The live-status gate on the API verifier (assertAccountActive) closes the same
    // hole for admin tokens issued BEFORE the ban; this closes it at the point of issuance.
    if (isPrivilegedRole(rec.role) && rec.status !== "active") {
      throw new Error(rec.status === "banned" ? "ACCOUNT_BANNED" : "ACCOUNT_SUSPENDED");
    }
    const mfa = await this.repo.getMfa(rec.userId);
    if (mfa?.enabled) await this.assertSecondFactor(rec.userId, mfa, input.totp, input.recoveryCode);
    // The password (and second factor, if any) checked out: forget the failure streak. Done only
    // now, so a correct password with a wrong TOTP code does not reset an attacker's counter.
    if (rec.failedAttempts !== 0 || rec.lockedUntilMs != null) await this.repo.clearLoginFailures(rec.userId);
    // The brand is the matched account's own site (falling back to an explicit siteId for the web).
    const resolvedSite = input.siteId ?? rec.siteId ?? undefined;
    // Platform tier (Issue 1): a platform_admin carries an explicit `platform` claim = the platform
    // it administers (profiles.platform_id). Every other role derives its platform from its site, so
    // no claim is minted for them (RLS current_platform() falls back to the site's platform).
    const platformId = rec.platformId ?? undefined;
    const token = await this.issueToken(rec.userId, rec.role, resolvedSite, platformId);
    const needsEnrolment = this.mfaRoles.has(rec.role) && !mfa?.enabled;
    const site = resolvedSite ? { site: resolvedSite } : {};
    const platform = platformId ? { platform: platformId } : {};
    return needsEnrolment
      ? { token, userId: rec.userId, role: rec.role, mfaEnrolmentRequired: true, ...site, ...platform }
      : { token, userId: rec.userId, role: rec.role, ...site, ...platform };
  }

  /**
   * Count one failed login against an account and apply whatever lock the schedule now says it has
   * earned (0197).
   *
   * A streak older than LOCKOUT_STREAK_TTL_MS is treated as starting over, so a lock can never be
   * assembled out of isolated mistakes weeks apart — and so a shared family phone does not slowly
   * accumulate its way into a permanent lockout.
   *
   * Never throws: a failure to record a failure must not change the answer the caller gives. The
   * worst case is one uncounted attempt, which is strictly better than a store hiccup turning a
   * wrong password into a 500 (and telling the attacker something changed).
   */
  /**
   * Fetch + verify a user's security answers, throwing the same two errors `resetPassword` throws.
   *
   * Extracted so the knowledge factor has ONE enforcement point used by all three callers (reset,
   * password change, step-up). The two-part shape of `verifyAllSecurityAnswers` — load the hashes,
   * then compare — is easy to call with the fail-closed count check accidentally omitted, and the
   * omission looks like working code: every answer verifies against an empty stored set, so a
   * caller that forgot it would let an operator who has set NO answers through on no answers at all.
   */
  private async assertSecurityAnswers(
    userId: string, answers: ReadonlyArray<{ key: string; answer: string }>,
  ): Promise<void> {
    const stored = await this.repo.getSecurityAnswers(userId);
    if (stored.length < SECURITY_ANSWERS_REQUIRED) throw new Error("SECURITY_QUESTIONS_NOT_SET");
    if (!(await this.verifyAllSecurityAnswers(stored, answers))) throw new Error("SECURITY_ANSWERS_MISMATCH");
  }

  private async noteLoginFailure(rec: CredentialRecord): Promise<void> {
    try {
      const stale = rec.lockedUntilMs != null && rec.lockedUntilMs + LOCKOUT_STREAK_TTL_MS < Date.now();
      const priorFailures = stale ? 0 : rec.failedAttempts;
      await this.repo.recordLoginFailure(rec.userId, lockMsForFailures(priorFailures + 1));
    } catch { /* recording is best-effort; the refusal above already happened */ }
  }

  /**
   * Prove a second factor for an already-authenticated operator, mid-session (0196).
   *
   * This is the step-up gate's verifier. It deliberately reuses the SAME primitives as login —
   * `assertSecondFactor` for TOTP and recovery codes, `verifyAllSecurityAnswers` for the knowledge
   * factor — rather than growing a parallel implementation. A second code path for "the same check,
   * but later" is how the two drift, and the half nobody looks at is the one that gets weaker.
   *
   * Which factor is required is the API's decision (see apps/api/src/stepup.ts: possession for the
   * platform tiers, knowledge for a site admin), because it is a policy question. This method's job
   * is to verify whatever was offered and report WHICH factor was proven, so the session record and
   * the audit trail can say what actually happened rather than merely that something did.
   *
   * Throws the same errors as login (MFA_REQUIRED / MFA_INVALID /
   * SECURITY_ANSWERS_MISMATCH / SECURITY_QUESTIONS_NOT_SET) so the API's existing error mapping
   * covers it with no new vocabulary.
   */
  async verifyStepUp(
    userId: string,
    proof: { totp?: string; recoveryCode?: string; answers?: ReadonlyArray<{ key: string; answer: string }> },
  ): Promise<{ method: "totp" | "recovery_code" | "security_questions" }> {
    if (proof.totp || proof.recoveryCode) {
      const mfa = await this.repo.getMfa(userId);
      // Fail CLOSED on an unenrolled or disabled account. The alternative — "no MFA configured, so
      // nothing to check, so pass" — would make the gate a no-op for exactly the accounts that
      // never finished enrolment, which are the weakest ones on the platform.
      if (!mfa?.enabled) throw new Error("MFA_REQUIRED");
      await this.assertSecondFactor(userId, mfa, proof.totp, proof.recoveryCode);
      return { method: proof.totp ? "totp" : "recovery_code" };
    }
    if (proof.answers) {
      await this.assertSecurityAnswers(userId, proof.answers);
      return { method: "security_questions" };
    }
    throw new Error("MFA_REQUIRED");
  }

  /**
   * Verify the second factor: a live TOTP code, or burn one single-use recovery code. Throws
   * MFA_REQUIRED when nothing was supplied and MFA_INVALID when it doesn't check out (the same
   * error for a bad code and a spent one, so neither reveals which).
   */
  private async assertSecondFactor(userId: string, mfa: MfaRecord, totp?: string, recoveryCode?: string): Promise<void> {
    if (totp) {
      const step = matchTotpStep(mfa.secret, totp);
      if (step === null) throw new Error("MFA_INVALID");
      // Single use (0196). Without this a code stays good for its whole ±1-step window — about 90
      // seconds — so one glimpsed or screenshotted code authorises a second sign-in, or (once the
      // step-up gate uses this same path) a second critical action the operator never approved. A
      // replay is reported as MFA_INVALID, identical to a wrong code, so a replaying attacker is
      // not told that the code was right and merely late.
      //
      // The visible cost, stated plainly because a support agent will eventually be asked: signing
      // in twice inside the same 30-second window requires waiting for the next code. That is how
      // every conformant TOTP implementation behaves.
      if (!(await this.repo.consumeTotpStep(userId, step))) throw new Error("MFA_INVALID");
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
   * Change your own password.
   *
   * For a PLAYER or MARKETER: the current password is the proof, which is what this has always
   * done and is appropriate for a self-service change.
   *
   * For a PRIVILEGED account (admin, platform_admin, platform_superadmin) the current password is
   * no longer enough, and `answers` (all stored security questions) is required as well.
   *
   * WHY, because the asymmetry is the point: until now the code path for a platform_superadmin
   * changing their password was byte-identical to a player's — same method, same single check, and
   * on the web the same player modal. Anyone holding a privileged session for the five minutes it
   * takes to read the current password off a sticky note, or who found the browser already logged
   * in, could rotate the password and own the account outright. A password reset ALREADY demanded
   * all three security answers for exactly these roles (0097); changing a password from inside a
   * session — the easier path, and the one an attacker actually has — demanded nothing. This closes
   * that gap with the mechanism already in place rather than a new one.
   *
   * Fails CLOSED: a privileged account that has never set its answers cannot change its password
   * (SECURITY_QUESTIONS_NOT_SET), which is the same stance `resetPassword` takes. The mandatory
   * setup gate at login means an operator is prompted to set them before they can get this far, so
   * this is not a lockout in practice — and it is the right failure if ever it were.
   *
   * Note that the step-up gate ALSO covers this route (/auth/password/change is deliberately not
   * exempt), so a platform admin additionally presents a live authenticator code. The two are not
   * redundant: the gate proves someone with the device is present now, these answers prove the
   * person knows the account's own secrets. Either alone has a gap the other covers.
   */
  async changePassword(
    userId: string, currentPassword: string, newPassword: string,
    answers?: ReadonlyArray<{ key: string; answer: string }>,
  ): Promise<{ changed: boolean }> {
    const pw = validatePassword(newPassword);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new Error("NOT_FOUND");
    const rec = await this.repo.findByPhone(profile.phone);
    if (!rec || !(await verifyPassword(currentPassword, rec.passwordHash))) throw new Error("INVALID_CREDENTIALS");
    // Order matters: the current password is verified FIRST, so a caller who does not know it
    // learns nothing about the account's security questions (not even whether any are set).
    if (isPrivilegedRole(profile.role)) await this.assertSecurityAnswers(userId, answers ?? []);
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
  async resetPassword(
    phone: string,
    newPassword: string,
    opts: { siteId?: string; answers?: ReadonlyArray<{ key: string; answer: string }> } = {},
  ): Promise<{ reset: boolean }> {
    const pw = validatePassword(newPassword);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    let normalized: string;
    try { normalized = normalizeMsisdn(phone); } catch { throw new Error("INVALID_PHONE"); }
    const { siteId, answers } = opts;
    // Scope to the caller's brand so a phone shared across brands can't cross-reset the wrong
    // account. Undefined siteId preserves single-tenant behaviour (default site).
    const rec = await this.repo.findByPhone(normalized, siteId);

    // ── PRIVILEGED accounts (admin / platform_admin / platform_superadmin) ──────────────────────
    // The reset is gated by the security-question SECOND FACTOR, INDEPENDENT of the
    // allowUnverifiedReset flag. It FAILS CLOSED: an account that has not set its answers cannot be
    // reset at all, so the phone-only takeover vector is shut even before the operator finishes
    // setup. All three answers must verify.
    //
    // EVERY failure below reports the SAME error, and that uniformity is load-bearing — it is the
    // other half of the decoy question keys in `decoyQuestionKeys`. The three outcomes used to be
    // distinguishable, and each told an unauthenticated caller something they should not know:
    //   SECURITY_QUESTIONS_NOT_SET  -> "this IS an operator account, and it is half-configured"
    //   SECURITY_ANSWERS_MISMATCH   -> "this IS an operator account, fully configured"
    //   RESET_DISABLED              -> "this is NOT an operator account"
    // Together they turned a public endpoint into a directory of the people who approve withdrawals
    // on this platform, ranked by how under-defended each one was. Serving decoy questions while
    // still answering differently when they are attempted would have closed nothing.
    //
    // The cost, stated plainly: an operator who genuinely mistypes an answer is told only that the
    // reset is unavailable, not which part failed. That is the right trade for a flow that is rare,
    // unauthenticated, and ends in a password change on an account that can move money — and they
    // keep an in-session path (`changePassword`) and a support channel. Diagnostic failure messages
    // on an anonymous endpoint are a luxury this endpoint cannot afford.
    if (rec && isPrivilegedRole(rec.role)) {
      try {
        await this.assertSecurityAnswers(rec.userId, answers ?? []);
      } catch {
        throw new Error("RESET_UNAVAILABLE");
      }
      await this.repo.setPasswordHash(rec.userId, await hashPassword(newPassword));
      return { reset: true };
    }

    // ── NON-privileged (players): the legacy stop-gap, still behind the opt-in flag ──────────────
    // The account lookup ran first so timing/response is uniform whether or not the phone exists
    // (anti-enumeration), and privileged accounts are handled above.
    if (!this.allowUnverifiedReset) throw new Error("RESET_UNAVAILABLE");
    const hash = await hashPassword(newPassword); // computed unconditionally: uniform timing
    if (rec) await this.repo.setPasswordHash(rec.userId, hash);
    return { reset: true };
  }

  /**
   * Verify that EVERY stored security answer has a matching provided answer (0097). Runs a scrypt
   * verify for every stored answer with NO early exit, so response time does not leak which answer
   * was wrong. A missing/blank supplied answer verifies against the empty string (always false).
   */
  private async verifyAllSecurityAnswers(
    stored: ReadonlyArray<SecurityAnswerHash>,
    provided: ReadonlyArray<{ key: string; answer: string }>,
  ): Promise<boolean> {
    if (stored.length < SECURITY_ANSWERS_REQUIRED) return false;
    const byKey = new Map<string, string>();
    for (const p of provided) {
      if (isValidSecurityQuestionKey(p.key) && typeof p.answer === "string" && !byKey.has(p.key)) {
        byKey.set(p.key, p.answer);
      }
    }
    let allOk = true;
    for (const s of stored) {
      const supplied = byKey.get(s.questionKey);
      const norm = supplied === undefined ? "" : normalizeSecurityAnswer(supplied);
      const ok = await verifyPassword(norm, s.answerHash);
      if (!ok) allOk = false; // keep looping: uniform timing
    }
    return allOk;
  }

  /**
   * Set (replace) the caller's security answers (0097). Enforces >= 3 DISTINCT valid catalog keys
   * with non-trivial answers; each NORMALIZED answer is scrypt-hashed (same scheme as passwords) so
   * plaintext never touches the database. Allowed for any account (harmless), but only privileged
   * roles are REQUIRED to have them (see securitySetupRequired).
   */
  /**
   * Which security questions the CALLER set on their OWN account.
   *
   * Not an enumeration risk, and the distinction from `getResetQuestionKeys` is the whole point:
   * that one answers an UNAUTHENTICATED caller about an ARBITRARY phone number, which is why it
   * serves decoys. This one answers an authenticated caller about themselves — they have already
   * proven they are that account, so telling them which three of the ten questions they picked
   * discloses nothing they do not own.
   *
   * It exists because the step-up prompt otherwise has to offer the whole catalog and make an
   * operator GUESS which three they chose, against a 10/min budget. For the `admin` tier, whose
   * second factor IS the questions, mis-remembering would mean being locked out of every critical
   * action on the platform — a self-inflicted outage, and the likeliest support call in this whole
   * feature. Returns [] when none are set, which the client reads as "finish setup first".
   */
  async myQuestionKeys(userId: string): Promise<string[]> {
    const stored = await this.repo.getSecurityAnswers(userId);
    return stored.map((s) => s.questionKey);
  }

  async setSecurityAnswers(userId: string, answers: ReadonlyArray<{ key: string; answer: string }>): Promise<{ set: true }> {
    const check = validateSecurityAnswerSet(answers.map((a) => ({ key: a.key, answer: a.answer })));
    if (!check.ok) throw new Error(`SECURITY_ANSWERS_${check.reason}`);
    const hashed: SecurityAnswerHash[] = await Promise.all(
      answers.map(async (a) => ({ questionKey: a.key, answerHash: await hashPassword(normalizeSecurityAnswer(a.answer)) })),
    );
    await this.repo.setSecurityAnswers(userId, hashed);
    return { set: true };
  }

  /**
   * Does this account still need to set up security questions? True only for a PRIVILEGED role that
   * has fewer than the required number of answers stored. Drives the mandatory client setup gate and
   * the /auth/me flag; enforcement of the reset itself is server-side in resetPassword (fail-closed).
   */
  async securitySetupRequired(userId: string): Promise<boolean> {
    const profile = await this.repo.getProfile(userId);
    if (!profile || !isPrivilegedRole(profile.role)) return false;
    const n = await this.repo.countSecurityAnswers(userId);
    return n < SECURITY_ANSWERS_REQUIRED;
  }

  // ── Security-question primitives for a NON-profile subject (0198: the marketer-app identity) ────
  //
  // The marketer app authenticates as a marketers.id, not a profiles.id, so its answers live in a
  // separate table owned by the marketer repo — not in IdentityRepository. Rather than grow a second
  // copy of the knowledge-factor crypto there (the exact drift the 0097 comments warn against), the
  // marketer flow hands its stored hashes to these methods, which reuse the SAME validation, scrypt
  // hashing, normalization and uniform-timing verification as the operator path. One enforcement
  // point; the only thing that differs between the two subjects is where the row is stored.

  /**
   * Validate a submitted answer set and return its scrypt hashes, ready to persist. Throws
   * `SECURITY_ANSWERS_<reason>` for an invalid set (too few, unknown/duplicate key, too short/long),
   * identical to `setSecurityAnswers`. Pure with respect to storage — the caller persists the result.
   */
  async hashSecurityAnswers(
    answers: ReadonlyArray<{ key: string; answer: string }>,
  ): Promise<SecurityAnswerHash[]> {
    const check = validateSecurityAnswerSet(answers.map((a) => ({ key: a.key, answer: a.answer })));
    if (!check.ok) throw new Error(`SECURITY_ANSWERS_${check.reason}`);
    return Promise.all(
      answers.map(async (a) => ({ questionKey: a.key, answerHash: await hashPassword(normalizeSecurityAnswer(a.answer)) })),
    );
  }

  /**
   * Verify provided answers against an already-loaded stored set. Throws SECURITY_QUESTIONS_NOT_SET
   * (fewer than the required number stored — fail closed) or SECURITY_ANSWERS_MISMATCH (one or more
   * wrong), the same two errors the operator reset throws. Reuses `verifyAllSecurityAnswers`, so the
   * no-early-exit uniform timing is identical. The caller loads `stored` from wherever that subject's
   * answers live.
   */
  async assertSecurityAnswersAgainst(
    stored: ReadonlyArray<SecurityAnswerHash>,
    provided: ReadonlyArray<{ key: string; answer: string }>,
  ): Promise<void> {
    if (stored.length < SECURITY_ANSWERS_REQUIRED) throw new Error("SECURITY_QUESTIONS_NOT_SET");
    if (!(await this.verifyAllSecurityAnswers(stored, provided))) throw new Error("SECURITY_ANSWERS_MISMATCH");
  }

  /**
   * Deterministic decoy question keys for a phone that has no answers, so a public "which questions
   * do I answer" step cannot be used to tell a real marketer account from a non-existent one. Thin
   * public wrapper over the same HMAC-seeded shuffle the operator reset uses.
   */
  publicDecoyQuestionKeys(seed: string): string[] {
    return this.decoyQuestionKeys(seed);
  }

  /**
   * Set a NON-privileged account's password by phone (+ brand), for the marketer-gated website
   * password reset (0198). The caller MUST have already verified that subject's security answers;
   * this is the credential write only.
   *
   * Refuses a privileged target outright — an operator account is never reset through the marketer
   * flow, whatever phone it shares — and returns false (rather than throwing a distinguishable error)
   * when no eligible account exists, so the caller can answer with one uniform code and leak nothing
   * about which accounts exist. A soft-deleted account is treated as absent.
   */
  async setNonPrivilegedPasswordByPhone(phone: string, newPassword: string, siteId?: string): Promise<boolean> {
    const pw = validatePassword(newPassword);
    if (!pw.ok) throw new Error(`PASSWORD_${pw.reason}`);
    let normalized: string;
    try { normalized = normalizeMsisdn(phone); } catch { throw new Error("INVALID_PHONE"); }
    const rec = await this.repo.findByPhone(normalized, siteId);
    if (!rec || rec.status === "deleted" || isPrivilegedRole(rec.role)) return false;
    await this.repo.setPasswordHash(rec.userId, await hashPassword(newPassword));
    return true;
  }

  /**
   * Public reset flow step 1: the question keys a privileged account must answer to reset. Returns
   * an EMPTY array for a non-privileged/unknown phone or one without answers set (anti-enumeration:
   * always 200, never reveals via an error whether a given phone is a privileged account beyond the
   * presence of keys). Brand-scoped like the reset itself.
   */
  async getResetQuestionKeys(phone: string, siteId?: string): Promise<string[]> {
    let normalized: string;
    try { normalized = normalizeMsisdn(phone); } catch { return this.decoyQuestionKeys(String(phone ?? "")); }
    const rec = await this.repo.findByPhone(normalized, siteId);
    if (!rec || !isPrivilegedRole(rec.role)) return this.decoyQuestionKeys(normalized);
    const stored = await this.repo.getSecurityAnswers(rec.userId);
    if (stored.length < SECURITY_ANSWERS_REQUIRED) return this.decoyQuestionKeys(normalized);
    return stored.map((s) => s.questionKey);
  }

  /**
   * Three plausible question keys for a phone that has none, so this endpoint stops being an
   * oracle that identifies operator accounts.
   *
   * THE LEAK THIS CLOSES: returning the real keys for a privileged account and `[]` for everyone
   * else meant an unauthenticated caller could test any phone number and learn, from the SHAPE of
   * the response alone, whether it belongs to an admin of this platform — and if so, which three
   * questions guard it. The route's own comment claimed anti-enumeration on the grounds that it
   * "always returns 200", which was true and beside the point: the status code was never the
   * channel, the body was. Run against a few hundred staff or suspected numbers at the 5/min limit,
   * that yields a target list of the people who approve withdrawals on a real-money platform,
   * ready for SIM-swap or spear-phishing — and, worst of all, an empty list for a privileged
   * account meant "this admin has not finished their security setup yet", ranking the targets by
   * how under-defended they are.
   *
   * DETERMINISTIC, not random: the same phone must always produce the same three questions, or
   * refreshing the page twice reveals which responses are fabricated. Derived by HMAC under the
   * service's own signing secret, so the mapping cannot be recomputed by an outsider and no state
   * is stored for phones that do not exist.
   *
   * What this does NOT claim: someone who answers the decoys gets a refusal, and that refusal has
   * to be indistinguishable from a genuine wrong answer — which is why `resetPassword` now
   * collapses all of its failure modes into one error. The two changes only work together.
   */
  private decoyQuestionKeys(seed: string): string[] {
    const digest = createHmac("sha256", this.secret).update(`reset-questions-decoy:${seed}`).digest();
    const keys = SECURITY_QUESTIONS.map((q) => q.key);
    // Fisher-Yates driven by the digest, then take the first three: a deterministic shuffle rather
    // than three independent picks, which could otherwise repeat a question and look wrong.
    const order = [...keys];
    for (let i = order.length - 1; i > 0; i--) {
      const j = digest[i % digest.length]! % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    return order.slice(0, SECURITY_ANSWERS_REQUIRED);
  }

  /**
   * Force-logout enforcement (0097) for the API verifier: throw SESSION_REVOKED when a PRIVILEGED
   * token was issued before the account's force-logout epoch. A no-op for non-privileged roles, so
   * high-volume player traffic pays no extra DB read — only the handful of admin tokens do.
   */
  async assertSessionValid(userId: string, role: string | undefined, iat: unknown): Promise<void> {
    // Force-logout applies to operators AND marketers (see SESSION_GATED_ROLES) — a marketer's
    // website session must actually end when they are signed out. Players still skip the DB read.
    if (!isSessionGatedRole(role)) return;
    const va = await this.repo.getSessionsValidAfterMs(userId);
    const iatSeconds = typeof iat === "number" ? iat : undefined;
    if (!isTokenSessionValid(iatSeconds, va)) throw new Error("SESSION_REVOKED");
  }

  /**
   * Live-status gate for the API verifier (#7). Reject a PRIVILEGED token whose account is no longer
   * active (suspended / banned / deleted / missing). Because admin authorization elsewhere trusts the
   * token's role claim and `fn_admin_set_user_status` does NOT force-logout, a banned admin would
   * otherwise keep full authority on an unexpired token; this revokes it on the very next request.
   *
   * Runs for privileged roles ONLY — a player/marketer token returns immediately with no DB read, so
   * high-volume traffic is unaffected (mirrors assertSessionValid). Status is checked, never role, so
   * an impersonation token (a platform_admin's real profile role while carrying a site `admin` token)
   * is judged on the operator's own live status, which is exactly right. Fails CLOSED: a missing
   * profile or a read error throws, so a revoked operator can never be admitted on an old token.
   */
  async assertAccountActive(userId: string, role: string | undefined): Promise<void> {
    if (!isPrivilegedRole(role)) return;
    const profile = await this.repo.getProfile(userId);
    if (!profile || profile.status !== "active") throw new Error("ACCOUNT_INACTIVE");
  }

  /** Read the caller's profile. Throws NOT_FOUND if no such identity. */  async me(userId: string): Promise<Profile> {
    const p = await this.repo.getProfile(userId);
    if (!p) throw new Error("NOT_FOUND");
    return p;
  }
}
