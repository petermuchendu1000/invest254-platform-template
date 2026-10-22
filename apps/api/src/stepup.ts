/**
 * Step-up second factor for operator actions, and the operator idle timeout.
 *
 * ── WHAT WAS MISSING ──────────────────────────────────────────────────────────────────────────
 * TOTP (migration 0027) and security questions (0097) were both fully built, both mandatory for
 * privileged roles, and both evaluated in exactly one place each: TOTP at sign-in, the questions on
 * a password reset. Nothing asked for a second factor at the moment a critical action happened. So
 * a session that authenticated at 09:00 could, at 16:00, adjust any wallet, approve any M-Pesa
 * payout, promote an account to admin, or rewrite the payment-gateway credentials — on the strength
 * of a code typed seven hours earlier, by whoever is holding the laptop now.
 *
 * ── WHY THIS IS DEFAULT-DENY ──────────────────────────────────────────────────────────────────
 * The privileged surface is ~120 mutating routes that move money, change credentials or roles, set
 * payout and fairness parameters, or reconfigure the payment rails. The obvious design — a list of
 * routes that need a second factor — is a list that is wrong the moment someone adds the 121st, and
 * wrong silently, in the unsafe direction. So the gate is spliced into EVERY authenticated mutating
 * route by the Router (see RouterOptions.stepUp), and the only list here is of the ROUTINE ones. A
 * new critical route is protected on the day it is written; the failure mode of forgetting is an
 * operator being asked for a code they did not expect, not a payout released without one.
 *
 * ── WHY THERE IS A WINDOW ─────────────────────────────────────────────────────────────────────
 * A code per action sounds stricter and is worse, because it is unusable: an operator clearing a
 * queue of fifty withdrawals would type fifty codes, and the feature would be switched off within a
 * week — a control that gets disabled protects nothing. So a proof is good for STEP_UP_WINDOW_MS,
 * and it is bound to the token that earned it: a second factor proven in one session never
 * authorises a different token, even for the same operator.
 *
 * ── THE IDLE RULE ─────────────────────────────────────────────────────────────────────────────
 * Enforced here, server-side, on the same per-session record. A client-side timer would be theatre:
 * `logout` in this app is already purely client-side — it clears localStorage while the 7-day JWT
 * stays valid — so "logging out" an idle admin in the browser would leave a fully working token in
 * whatever captured it. The rule is fail-closed by construction: a privileged token older than the
 * idle window with NO activity record is idle BY DEFINITION, so the absence of state refuses rather
 * than admits. Only a token issued inside the window may legitimately have no record yet.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────
 * It challenges a SESSION. Three privileged paths have no session to challenge and are untouched
 * here; each needs its own answer and none should be assumed covered by this file:
 *   - `POST /w/act`, which approves a real payout from an HMAC link in an email, with no login;
 *   - `POST /telegram/webhook`, the same decision from a chat button;
 *   - the engine's unattended pool top-up, which runs as the first platform_superadmin it finds.
 */
import { ApiError, type Ctx, type Middleware } from "./http.js";

/** How long a proven second factor authorises further critical actions on the same session. */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

/**
 * How long a privileged session may sit idle before it is refused and must sign in again.
 *
 * Five minutes, as specified. Deliberately the same as STEP_UP_WINDOW_MS: two different clocks on
 * one session is a thing nobody can reason about at 2am during an incident, and the shorter of the
 * two would silently dominate anyway.
 */
export const IDLE_WINDOW_MS = 5 * 60_000;

/**
 * Roles the gate applies to. Players and marketers are deliberately excluded: they have no
 * privileged surface, they are the overwhelming majority of traffic, and — load-bearing detail —
 * a marketer token carries `sub = marketers.id`, which is NOT a `profiles.id`. Letting marketer
 * traffic reach the per-session store would fail its foreign key on every request.
 */
const GATED_ROLES: ReadonlySet<string> = new Set(["admin", "platform_admin", "platform_superadmin"]);

export const isGatedRole = (role: string | undefined | null): boolean =>
  typeof role === "string" && GATED_ROLES.has(role);

/**
 * The ROUTINE authenticated mutating routes: everything else gets challenged.
 *
 * Entries are `METHOD <registered route pattern>`, matched exactly against `ctx.routePath`, so a
 * typo here fails SAFE (the route keeps its challenge) rather than opening one by accident.
 *
 * The test for inclusion is not "is this harmless" but "would requiring a fresh code here make an
 * operator's ordinary minute-to-minute work impossible, while buying nothing". Answering a customer
 * in live chat is on this list. Broadcasting to every user on the platform is not, because that is
 * a phishing cannon pointed at the customer base, however routine it feels to send.
 */
export const STEP_UP_EXEMPT: ReadonlySet<string> = new Set([
  // ── Authentication itself. Gating these is a deadlock: you cannot prove a second factor if
  // proving it requires having already proved it, and you cannot enrol if enrolling needs a code.
  "POST /api/v1/auth/step-up",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/mfa/enroll",
  "POST /api/v1/auth/mfa/confirm",
  "POST /api/v1/auth/security-questions",
  // NOTE the two absences above, both intentional:
  //   /auth/mfa/disable is NOT here — removing your own second factor is exactly the action an
  //     attacker on a stolen session wants, and it already demands a live code of its own.
  //   /auth/password/change is NOT here — it is the action the brief singled out. For an admin the
  //     challenge is the security questions; for the platform tiers it is TOTP.

  // ── Operator day-to-day: support, chat, tickets, brand content. High frequency, low stakes.
  "POST /api/v1/admin/chat/threads/:id/messages",
  "POST /api/v1/admin/chat/threads/:id/attachments",
  "POST /api/v1/admin/chat/threads/:id/read",
  "POST /api/v1/admin/chat/threads/:id/status",
  "POST /api/v1/tickets",
  "POST /api/v1/tickets/:id/comments",
  "POST /api/v1/tickets/:id/status",
  "POST /api/v1/tickets/:id/escalate",
  "POST /api/v1/community",
  "POST /api/v1/community/:id/pin",
  "POST /api/v1/community/:id/close",
  "POST /api/v1/community/:id/delete",

  // ── Per-user notices. The BROADCAST route is deliberately absent (see above).
  "POST /api/v1/admin/users/:id/notifications",
  "POST /api/v1/admin/notifications/:id/resolve",
  "POST /api/v1/admin/notifications/audience-count",
  "POST /api/v1/admin/notifications/resolve-category",

  // ── The operator's own device registration for payout alerts (F-48: own device only).
  "POST /api/v1/admin/push/subscribe",
  "POST /api/v1/admin/push/unsubscribe",

  // ── Asking for an add-on, and withdrawing that ask. Granting or pricing one is not routine.
  "POST /api/v1/addons/request",
  "POST /api/v1/addons/requests/:id/cancel",

  // ── Connectivity tests. These prove a credential reaches its provider; they do not store one.
  "POST /api/v1/platform/registrar/config/test",
  "POST /api/v1/platform/payment-providers/:code/config/test",
  "POST /api/v1/platform/payment-scopes/:type/:id/gateways/:code/test",
]);

/** Which second factor a role must present. */
export type StepUpFactor = "totp" | "security_questions";

/**
 * The platform tiers prove possession (TOTP, per the brief: "google authenticator code"); a site
 * admin proves knowledge (the security questions, also per the brief).
 *
 * Worth being clear-eyed, since this is a real-money platform: these are not equivalent. Security
 * questions are static and often discoverable — a mother's maiden name does not change when it
 * leaks — so for the `admin` tier this is a speed bump that stops a casual session-stealer, not a
 * determined attacker. TOTP is the real control. The split is what was asked for; raising `admin`
 * to TOTP is a one-line change here if that call is revisited.
 */
export function requiredFactor(role: string): StepUpFactor {
  return role === "admin" ? "security_questions" : "totp";
}

/** Per-session state the gate reads. `null` = no record of this session at all. */
export interface PrivilegedSession {
  lastSeenAtMs: number;
  stepUpAtMs: number | null;
}

export interface StepUpDeps {
  /** Read the session record for (user, token iat). */
  getSession(userId: string, tokenIatSeconds: number): Promise<PrivilegedSession | null>;
  /** Create-or-update the session's last-seen stamp. Called on every gated request. */
  touchSession(userId: string, tokenIatSeconds: number): Promise<void>;
  /** Current time, injectable so the windows can be tested without waiting five minutes. */
  now?: () => number;
}

/**
 * Read the standard JWT `iat` (seconds) off the verified claims.
 *
 * Fails closed: a privileged token with no usable `iat` cannot be tied to a session record, so it
 * cannot be shown to be inside the idle window, so it is refused. This mirrors
 * `isTokenSessionValid` (0097), which already treats a missing `iat` as revoked.
 */
export function tokenIatSeconds(claims: { raw?: unknown } | undefined): number | null {
  const iat = (claims?.raw as { iat?: unknown } | undefined)?.iat;
  return typeof iat === "number" && Number.isFinite(iat) ? Math.floor(iat) : null;
}

/**
 * Is this session inside the idle window?
 *
 * Pure, and the place the fail-closed rule actually lives, so it can be tested in isolation:
 *   - a record → measured from its last-seen stamp;
 *   - NO record and the token was issued inside the window → the genuine first request after
 *     login, allowed (and the caller then writes the record);
 *   - NO record and an older token → idle by definition, refused. This is the case a naive
 *     implementation waves through, and it is precisely the stolen-token case: a token from last
 *     Tuesday whose session row was never written or has since been pruned.
 */
export function withinIdleWindow(
  session: PrivilegedSession | null, tokenIatSeconds: number, nowMs: number, idleMs = IDLE_WINDOW_MS,
): boolean {
  if (session) return nowMs - session.lastSeenAtMs < idleMs;
  return nowMs - tokenIatSeconds * 1000 < idleMs;
}

/** Has a second factor been proven on this session recently enough? */
export function hasFreshStepUp(
  session: PrivilegedSession | null, nowMs: number, windowMs = STEP_UP_WINDOW_MS,
): boolean {
  if (!session || session.stepUpAtMs == null) return false;
  return nowMs - session.stepUpAtMs < windowMs;
}

/** Does this request need a fresh second factor? */
export function needsStepUp(ctx: Ctx): boolean {
  if (!isGatedRole(ctx.claims?.role)) return false;
  // No pattern means the dispatcher did not set one, which should be impossible on a matched
  // request. Treat it as needing the challenge rather than guessing from the concrete path.
  const key = `${ctx.method} ${ctx.routePath ?? ""}`;
  return !STEP_UP_EXEMPT.has(key);
}

/**
 * The IDLE half, enforced in the verifier wrapper rather than in the route middleware below.
 *
 * It has to live there because it must see EVERY authenticated request, not just the mutating ones.
 * An operator who spends ten minutes reading the withdrawals queue is working, not idle — if only
 * mutating routes recorded activity, their next click would be refused as inactivity, and the
 * feature would be (rightly) called broken and removed. Reads keep a session alive; only genuine
 * absence ends it.
 *
 * Returns the error to throw, or null to allow, so the caller decides how to surface it (the
 * verifier turns any throw into a 401, which is exactly what an idle session should produce).
 * Privileged roles only — a player token does no DB work here at all.
 */
export function makeIdleGate(deps: StepUpDeps) {
  const now = deps.now ?? Date.now;
  return async function assertNotIdle(userId: string, role: string | undefined, rawIat: unknown): Promise<void> {
    if (!isGatedRole(role)) return;
    const iat = typeof rawIat === "number" && Number.isFinite(rawIat) ? Math.floor(rawIat) : null;
    if (iat === null) throw new ApiError("SESSION_IDLE", "session expired, sign in again", 401);
    const t = now();
    const session = await deps.getSession(userId, iat);
    if (!withinIdleWindow(session, iat, t)) {
      throw new ApiError("SESSION_IDLE", "signed out after 5 minutes of inactivity", 401);
    }
    // Record the activity only after the session is known good, so a refused request can never
    // keep a dead session breathing.
    await deps.touchSession(userId, iat);
  };
}

/**
 * The STEP-UP half: the middleware the Router splices into every authenticated mutating route.
 *
 * It does not re-check the idle window — `makeIdleGate` already ran in the verifier for this same
 * request, and has already refreshed the last-seen stamp, so repeating it here would read state
 * this request just wrote.
 *
 * The failure is a distinct, actionable code rather than a bare 403 because the client has to tell
 * it apart from an expired session: SESSION_IDLE means show the login screen, STEP_UP_REQUIRED
 * means show the code prompt and retry the same call.
 *
 * WHICH prompt is a separate question, and the answer is NOT encoded in the error code. The client
 * asks `GET /auth/step-up`, which reports the required factor and whether it is currently
 * satisfied. Two codes (…_TOTP / …_ANSWERS) would put the role-to-factor mapping in two places and
 * let them drift; one code plus one authoritative endpoint cannot drift.
 */
export function requireStepUp(deps: StepUpDeps): Middleware {
  const now = deps.now ?? Date.now;
  return async (ctx: Ctx) => {
    if (!needsStepUp(ctx)) return;                          // routine route, or a non-gated role
    const iat = tokenIatSeconds(ctx.claims);
    if (iat === null) throw new ApiError("SESSION_IDLE", "session expired, sign in again", 401);
    const session = await deps.getSession(ctx.claims!.userId, iat);
    if (hasFreshStepUp(session, now())) return;
    const factor = requiredFactor(ctx.claims!.role!);
    throw new ApiError(
      "STEP_UP_REQUIRED",
      factor === "totp"
        ? "confirm with your authenticator code to continue"
        : "answer your security questions to continue",
      403,
    );
  };
}
