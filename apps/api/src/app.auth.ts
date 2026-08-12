import { Router, ApiError, requireAuth, rateLimit, type Ctx } from "./http.js";
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
  USER_NOT_FOUND: 404,
  NOT_FOUND: 404,
};

function statusFor(code: string): number {
  if (AUTH_STATUS[code]) return AUTH_STATUS[code]!;
  if (code.startsWith("PASSWORD_") || code.startsWith("USERNAME_")) return 400;
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
 * Resolve the brand a public auth call belongs to (docs/22 Task E). The frontend (which already
 * resolved its brand via GET /site/brand) passes its `host` in the body (or `?host=`); we map it
 * to a `site_id` so register/login are brand-scoped. No hint → undefined → the default site
 * (unchanged single-tenant behaviour), so existing callers keep working.
 */
async function resolveSiteId(ctx: Ctx, body: Record<string, unknown>, deps: ApiDeps): Promise<string | undefined> {
  const host = (optionalString(body, "host") ?? ctx.query.get("host") ?? undefined)?.trim().toLowerCase();
  if (!host) return undefined;
  const brand = await deps.brandByHost(host);
  return brand?.siteId;
}

/** Register the auth routes (register/login are public; /me requires a bearer token). */
export function registerAuthRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  // Throttle credential endpoints per source IP to blunt brute-force / credential stuffing
  // (scrypt already makes each guess costly; this caps the rate). Tunable via env.
  const authLimit = rateLimit({ name: "auth", by: "ip", limit: Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 40, windowMs: 60_000 });

  router.post(`${BASE}/auth/register`, authLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const phone = requireString(body, "phone");
    const username = requireString(body, "username");
    const password = requireString(body, "password");
    const referralCode = optionalString(body, "referral_code"); // first-touch attribution (optional)
    const siteId = await resolveSiteId(ctx, body, deps);
    const s = await domain(() => deps.auth.register({ phone, username, password,
      ...(referralCode !== undefined ? { referralCode } : {}),
      ...(siteId ? { siteId } : {}) }));
    return { status: 201, body: { token: s.token, userId: s.userId, role: s.role, ...(s.site ? { site: s.site } : {}) } };
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
    return domain(() => deps.auth.resetPassword(phone, newPassword));
  });

  router.get(`${BASE}/auth/me`, auth, async (ctx: Ctx) => {
    const userId = ctx.claims!.userId;
    // Tolerate callers that aren't a self-managed identity (e.g. DEV header auth): fall back to claims.
    const profile = await deps.auth.me(userId).catch((e) => {
      if (e instanceof Error && e.message === "NOT_FOUND") return null;
      throw e;
    });
    const username = profile?.username ?? (await deps.resolveHandle(userId));
    return {
      userId,
      role: profile?.role ?? ctx.claims!.role ?? "player",
      username,
      phone: profile?.phone ?? null,
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
