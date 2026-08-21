import { Router, ApiError, requireAuth, rateLimit, type Ctx } from "./http.js";
import { SECURITY_QUESTIONS } from "@invest254/shared";
import type { ApiDeps } from "./app.js";

/**
 * Auth routes (Issue G4): self-managed phone + password registration / login and the
 * authenticated `/me` echo. Thin transport over the engine AuthService (G3) — scrypt
 * hashing, the atomic 0015 register RPC, the active-status gate and HS256 JWT issuance all
 * live there. This module only parses/validates input, maps domain error codes to HTTP
 * statuses, and serializes the session. Issued tokens are verified by the same
 * `makeVerifier` the protected routes already use, so no other route changes.
 */

const BASE = "/api/v1";

/** Auth domain-error code -> HTTP status (PASSWORD_ and USERNAME_ suffixes handled by prefix). */
const AUTH_STATUS: Readonly<Record<string, number>> = {
  INVALID_PHONE: 400,
  PHONE_TAKEN: 409,
  USERNAME_TAKEN: 409,
  REGISTRATION_CONFLICT: 409,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_BANNED: 403,
  INVALID_REFERRAL_CODE: 400,
  MFA_REQUIRED: 401,
  MFA_INVALID: 401,
  MFA_NOT_ENROLLING: 400,
  RESET_DISABLED: 403,
  // Security-question second factor (0097). Privileged reset gating + setup validation.
  SECURITY_QUESTIONS_NOT_SET: 403, // privileged account has not set answers → reset fails closed
  SECURITY_ANSWERS_MISMATCH: 401,  // one or more supplied answers did not verify
  USER_NOT_FOUND: 404,
  NOT_FOUND: 404,
};

function statusFor(code: string): number {
  if (AUTH_STATUS[code]) return AUTH_STATUS[code]!;
  // Setup-validation failures (SECURITY_ANSWERS_TOO_FEW / _INVALID_KEY / _DUPLICATE_KEY / …) are
  // client input errors → 400. The explicit AUTH_STATUS entries above (MISMATCH 401) win first.
  if (code.startsWith("PASSWORD_") || code.startsWith("USERNAME_") || code.startsWith("SECURITY_ANSWERS_")) return 400;
  return 0; // unknown → let the router map to 500
}

/** Run an AuthService call, translating its thrown error codes into controlled ApiErrors. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim(); // normalizeMsisdn throws "INVALID_PHONE: <input>"
    const status = statusFor(code);
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("VALIDATION", "JSON object body required", 400);
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) throw new ApiError("VALIDATION", `${key} must be a non-empty string`, 400);
  return v;
}

/** Read an optional string field; rejects a present-but-non-string value. */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ApiError("VALIDATION", `${key} must be a string`, 400);
  return v;
}

/**
 * Parse `body.answers` into a clean [{key, answer}] list for the security-question flows (0097).
 * Tolerant of a missing field (→ []) but rejects a present-but-malformed shape so the engine's
 * validator sees well-typed input. Deep validation (distinct keys, count, length) lives in
 * AuthService/shared; this is only the transport shape guard.
 */
function parseSecurityAnswers(body: Record<string, unknown>): Array<{ key: string; answer: string }> {
  const raw = body["answers"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError("VALIDATION", "answers must be an array", 400);
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError("VALIDATION", `answers[${i}] must be an object`, 400);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.answer !== "string") {
      throw new ApiError("VALIDATION", `answers[${i}] requires string key + answer`, 400);
    }
    return { key: o.key, answer: o.answer };
  });
}

/**
 * Resolve the brand a public auth call belongs to (docs/22 Task E). The frontend already resolved
 * its brand server-side (GET /site/brand, one deployment serves many domains) and passes it back
 * explicitly as `site` (the brand slug — or domain/id, anything the sites resolver matches) on the
 * register/login body. We map that reference to a `site_id` so the account + the issued token's
 * `site` claim bind to the correct brand.
 *
 * WHY THIS EXISTS (GAP 1): the API is a SINGLE shared host (e.g. invest254-api.fly.dev); a browser
 * on tamutraders.com never reveals that brand to the API on its own. Without an explicit brand
 * reference, register/login fell through to the default site, so EVERY brand's players pooled into
 * site #1 — a silent multi-tenant isolation break. The web now always sends `site` (see
 * apps/web/src/lib/auth/useAuthActions.ts).
 *
 * Resolution priority: explicit `site` (body or `?site=`) > `host` (body or `?host=`, kept for
 * API/curl callers + backward compatibility). Whatever is supplied is validated against the sites
 * table by brandByHost (ACTIVE brands only), so an unknown/inactive reference resolves to nothing
 * and falls back to the default site — client input is never trusted blindly. No hint → undefined →
 * the default site (unchanged single-tenant behaviour), so existing callers keep working.
 */
async function resolveSiteId(ctx: Ctx, body: Record<string, unknown>, deps: ApiDeps): Promise<string | undefined> {
  const ref = (
    optionalString(body, "site") ?? ctx.query.get("site") ??
    optionalString(body, "host") ?? ctx.query.get("host") ?? undefined
  )?.trim().toLowerCase();
  if (!ref) return undefined;
  const brand = await deps.brandByHost(ref);
  return brand?.siteId;
}

/** Register the auth routes (register/login are public; /me requires a bearer token). */
export function registerAuthRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  // Throttle credential endpoints per source IP to blunt brute-force / credential stuffing
  // (scrypt already makes each guess costly; this caps the rate). Tunable via env.
  const authLimit = rateLimit({ name: "auth", by: "ip", limit: Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 40, windowMs: 60_000 });

  router.post(`${BASE}/auth/register`, authLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("registrations")))
      throw new ApiError("SYSTEM_DISABLED", "New registrations are temporarily disabled by the platform.", 403);
    const body = asObject(ctx.body);
    const phone = requireString(body, "phone");
    const username = requireString(body, "username");
    const password = requireString(body, "password");
    const referralCode = optionalString(body, "referral_code"); // first-touch attribution (optional)
    const siteId = await resolveSiteId(ctx, body, deps);
    const s = await domain(() => deps.auth.register({ phone, username, password,
      ...(referralCode !== undefined ? { referralCode } : {}),
      ...(siteId ? { siteId } : {}) }));
    return { status: 201, body: { token: s.token, userId: s.userId, role: s.role, ...(s.site ? { site: s.site } : {}),
      ...(s.welcomeBonusCents ? { welcomeBonusCents: s.welcomeBonusCents } : {}) } };
  });

  router.post(`${BASE}/auth/login`, authLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const phone = requireString(body, "phone");
    const password = requireString(body, "password");
    // Second factor is optional in the payload: only accounts with MFA enabled require it, and
    // the service decides — so an unenrolled player's login is unchanged.
    const totp = optionalString(body, "totp");
    const recoveryCode = optionalString(body, "recovery_code");
    const siteId = await resolveSiteId(ctx, body, deps);
    const s = await domain(() => deps.auth.login({
      phone,
      password,
      ...(totp !== undefined ? { totp } : {}),
      ...(recoveryCode !== undefined ? { recoveryCode } : {}),
      ...(siteId ? { siteId } : {}),
    }));
    return {
      token: s.token,
      userId: s.userId,
      role: s.role,
      ...(s.mfaEnrolmentRequired ? { mfaEnrolmentRequired: true } : {}),
      ...(s.site ? { site: s.site } : {}),
    };
  });

  // ── MFA (TOTP) — privileged accounts. Enrolment is self-service; enforcement is in AuthService.
  const mfaLimit = rateLimit({ name: "mfa", by: "user", limit: Number(process.env.RATE_LIMIT_MFA_PER_MIN) || 10, windowMs: 60_000 });

  router.get(`${BASE}/auth/mfa`, auth, async (ctx: Ctx) =>
    domain(() => deps.auth.mfaStatus(ctx.claims!.userId)));

  /** Returns the secret, otpauth:// QR URI and recovery codes ONCE. MFA is inactive until confirm. */
  router.post(`${BASE}/auth/mfa/enroll`, auth, mfaLimit, async (ctx: Ctx) =>
    domain(() => deps.auth.beginMfaEnrolment(ctx.claims!.userId)));

  router.post(`${BASE}/auth/mfa/confirm`, auth, mfaLimit, async (ctx: Ctx) => {
    const code = requireString(asObject(ctx.body), "code");
    return domain(() => deps.auth.confirmMfa(ctx.claims!.userId, code));
  });

  router.post(`${BASE}/auth/mfa/disable`, auth, mfaLimit, async (ctx: Ctx) => {
    const code = requireString(asObject(ctx.body), "code");
    return domain(() => deps.auth.disableMfa(ctx.claims!.userId, code));
  });

  // ── Password management ──
  // `change` proves possession via the current password, so it is always available. `reset` is the
  // no-OTP stop-gap: AuthService refuses it unless explicitly enabled, and it is tightly throttled
  // because an unverified reset is an account-takeover vector.
  const resetLimit = rateLimit({ name: "password-reset", by: "ip", limit: Number(process.env.RATE_LIMIT_RESET_PER_MIN) || 5, windowMs: 60_000 });

  router.post(`${BASE}/auth/password/change`, auth, authLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const currentPassword = requireString(body, "current_password");
    const newPassword = requireString(body, "new_password");
    return domain(() => deps.auth.changePassword(ctx.claims!.userId, currentPassword, newPassword));
  });

  router.post(`${BASE}/auth/password/reset`, resetLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const phone = requireString(body, "phone");
    const newPassword = requireString(body, "new_password");
    // Security-question second factor (0097): for a PRIVILEGED account these are REQUIRED and must
    // all verify, independent of the unverified-reset flag; the engine fails closed if unset. A
    // player's reset ignores them (unchanged legacy behaviour).
    const answers = parseSecurityAnswers(body);
    // Brand-scope the reset the same way register/login are scoped. A phone is unique only WITHIN a
    // brand, so without this the reset targeted whichever account (across brands) findByPhone
    // returned first — it could silently rewrite the wrong brand's password (and report success),
    // leaving the real account unchanged. No hint → default site (single-tenant behaviour).
    const siteId = await resolveSiteId(ctx, body, deps);
    return domain(() => deps.auth.resetPassword(phone, newPassword, { ...(siteId ? { siteId } : {}), answers }));
  });

  // ── Security questions (0097): the knowledge second factor for privileged password resets ──────
  // Public catalog of selectable questions (labels shown in the setup + reset UI). No secrets; light
  // rate-limit only. The web can also import these from @invest254/shared, but the endpoint keeps the
  // catalog server-authoritative and available without bundling coupling.
  router.get(`${BASE}/auth/security-questions/catalog`, authLimit, async () => ({
    questions: SECURITY_QUESTIONS.map((q) => ({ key: q.key, label: q.label })),
  }));

  // Authenticated: set (replace) MY three security answers. Used by the mandatory setup gate after a
  // privileged account is force-logged-out and logs back in. Throttled per user.
  router.post(`${BASE}/auth/security-questions`, auth, mfaLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const answers = parseSecurityAnswers(body);
    return domain(() => deps.auth.setSecurityAnswers(ctx.claims!.userId, answers));
  });

  // Public reset step 1: which question keys must be answered to reset this phone's password. Returns
  // { keys: [] } for a non-privileged/unknown phone or one without answers set (anti-enumeration:
  // always 200). Same brand scoping + throttle as the reset itself.
  router.post(`${BASE}/auth/password/reset-questions`, resetLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const phone = requireString(body, "phone");
    const siteId = await resolveSiteId(ctx, body, deps);
    const keys = await domain(() => deps.auth.getResetQuestionKeys(phone, siteId));
    return { keys };
  });

  router.get(`${BASE}/auth/me`, auth, async (ctx: Ctx) => {
    const userId = ctx.claims!.userId;
    // Tolerate callers that aren't a self-managed identity (e.g. DEV header auth): fall back to claims.
    const profile = await deps.auth.me(userId).catch((e) => {
      if (e instanceof Error && e.message === "NOT_FOUND") return null;
      throw e;
    });
    const username = profile?.username ?? (await deps.resolveHandle(userId));
    // Security-question setup gate (0097): true only for a privileged account that has not yet set
    // its answers. The client uses this to force the mandatory setup screen; the reset endpoint
    // enforces the same server-side (fail-closed), so a bypassed client cannot skip it.
    const securitySetupRequired = await deps.auth.securitySetupRequired(userId).catch(() => false);
    return {
      userId,
      role: profile?.role ?? ctx.claims!.role ?? "player",
      username,
      phone: profile?.phone ?? null,
      securitySetupRequired,
    };
  });

  // Re-issue a token reflecting the caller's CURRENT role + status — no credentials required.
  // A JWT's `role` claim is a snapshot from issue time, so a role change (e.g. a promotion to
  // admin/superadmin, or a demotion) does not take effect until the token is replaced. Without
  // this, a promoted user sees their new role in /auth/me (read live from the DB) while every
  // role-gated route still 403s against the stale claim. The client calls this on load when it
  // detects that drift, so permission changes apply on the next visit instead of forcing a
  // manual sign-out/sign-in. The active-status gate also fail-closes a suspended/banned account.
  router.post(`${BASE}/auth/refresh`, auth, async (ctx: Ctx) => {
    const userId = ctx.claims!.userId;
    const profile = await domain(() => deps.auth.me(userId));
    if (profile.status !== "active") {
      throw new ApiError(`ACCOUNT_${profile.status.toUpperCase()}`, `account is ${profile.status}`, 403);
    }
    const token = await deps.auth.issueToken(userId, profile.role);
    return { token, userId, role: profile.role };
  });
}
