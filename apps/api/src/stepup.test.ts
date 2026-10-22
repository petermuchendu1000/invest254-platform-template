import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withinIdleWindow, hasFreshStepUp, needsStepUp, isGatedRole, requiredFactor, tokenIatSeconds,
  requireStepUp, makeIdleGate, STEP_UP_EXEMPT, STEP_UP_WINDOW_MS, IDLE_WINDOW_MS,
  type PrivilegedSession,
} from "./stepup.js";
import { ApiError, type Ctx } from "./http.js";

const S = 1_000;
const sess = (lastSeenAtMs: number, stepUpAtMs: number | null = null): PrivilegedSession =>
  ({ lastSeenAtMs, stepUpAtMs });

/** Minimal Ctx for the gate: it reads only method, routePath and claims. */
function ctxFor(method: string, routePath: string, role: string, iat?: number): Ctx {
  return {
    method, routePath, path: routePath, params: {}, query: new URLSearchParams(), body: null,
    claims: { userId: "u1", role, raw: iat === undefined ? {} : { iat } },
    req: {} as Ctx["req"], res: {} as Ctx["res"],
  } as unknown as Ctx;
}

// ─────────────────────────── the fail-closed idle rule ───────────────────────────

test("idle: a session seen inside the window is alive, outside it is not", () => {
  const now = 1_000_000_000;
  assert.equal(withinIdleWindow(sess(now - 60 * S), now / S, now), true);
  assert.equal(withinIdleWindow(sess(now - (IDLE_WINDOW_MS - 1)), now / S, now), true);
  assert.equal(withinIdleWindow(sess(now - IDLE_WINDOW_MS), now / S, now), false);
  assert.equal(withinIdleWindow(sess(now - 60 * 60 * S), now / S, now), false);
});

test("idle: NO session record with a FRESH token is the first request after login — allowed", () => {
  const now = 1_000_000_000;
  const iat = (now - 2 * S) / S;                       // issued two seconds ago
  assert.equal(withinIdleWindow(null, iat, now), true);
});

test("idle: NO session record with an OLD token is idle by definition — refused", () => {
  /**
   * This is the whole point of the design, and the case a naive implementation waves through:
   * "no activity recorded, so nothing to compare against, so allow". That is exactly the stolen
   * or long-dormant token — issued last Tuesday, session row never written or since pruned — and
   * admitting it would hand it the full authority of a 2FA'd operator session.
   */
  const now = 1_000_000_000;
  const old = (now - 7 * 24 * 60 * 60 * S) / S;        // a week-old token, as the 7-day TTL allows
  assert.equal(withinIdleWindow(null, old, now), false);
  // And right at the boundary, still refused.
  assert.equal(withinIdleWindow(null, (now - IDLE_WINDOW_MS) / S, now), false);
});

test("idle: the window is five minutes, as specified", () => {
  // Pinned to the literal: this is a number the product owner chose, not an implementation detail.
  assert.equal(IDLE_WINDOW_MS, 5 * 60_000);
});

// ─────────────────────────── the step-up window ───────────────────────────

test("step-up: absent or never-proven is never fresh", () => {
  const now = 1_000_000_000;
  assert.equal(hasFreshStepUp(null, now), false);
  assert.equal(hasFreshStepUp(sess(now, null), now), false);
});

test("step-up: a proof is good for its window and no longer", () => {
  const now = 1_000_000_000;
  assert.equal(hasFreshStepUp(sess(now, now - 1 * S), now), true);
  assert.equal(hasFreshStepUp(sess(now, now - (STEP_UP_WINDOW_MS - 1)), now), true);
  assert.equal(hasFreshStepUp(sess(now, now - STEP_UP_WINDOW_MS), now), false);
  assert.equal(hasFreshStepUp(sess(now, now - 60 * 60 * S), now), false);
});

test("step-up: a session that is ACTIVE but whose proof has aged out is still challenged", () => {
  // The two clocks are independent: staying busy must not renew a second factor, or one code at
  // the start of a shift would authorise every critical action for the whole shift.
  const now = 1_000_000_000;
  const s = sess(now - 1 * S, now - (STEP_UP_WINDOW_MS + 1));
  assert.equal(withinIdleWindow(s, now / S, now), true);
  assert.equal(hasFreshStepUp(s, now), false);
});

// ─────────────────────────── default-deny route classification ───────────────────────────

test("classification: an unknown mutating route is challenged, not waved through", () => {
  // The property the whole design rests on: a route nobody classified gets the challenge. If this
  // ever inverts, every future critical route ships unprotected and silently.
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/admin/wallets/:id/adjust", "admin")), true);
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/some/route/nobody/has/written/yet", "admin")), true);
  assert.equal(needsStepUp(ctxFor("DELETE", "/api/v1/platform/billing/charges/:id", "platform_admin")), true);
});

test("classification: a missing route pattern is challenged rather than guessed at", () => {
  const c = ctxFor("POST", "/api/v1/admin/wallets/:id/adjust", "admin");
  delete (c as { routePath?: string }).routePath;
  assert.equal(needsStepUp(c), true);
});

test("classification: the routine routes named in the exempt list are not challenged", () => {
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/admin/chat/threads/:id/messages", "admin")), false);
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/tickets", "admin")), false);
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/auth/step-up", "platform_superadmin")), false);
});

test("classification: the deliberate NON-exemptions stay challenged", () => {
  /**
   * Each of these is a route a reasonable person might have exempted as routine. They are the
   * reason the exempt list is reviewed rather than grown by reflex.
   */
  // Broadcasting to every user is a phishing cannon aimed at the customer base.
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/admin/notifications/broadcast", "admin")), true);
  // Removing your own second factor is the first thing an attacker on a stolen session wants.
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/auth/mfa/disable", "platform_admin")), true);
  // Changing a password is the action the brief singled out.
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/auth/password/change", "admin")), true);
  // Rejecting a payout is as irreversible as approving one, and denies every cash-out at scale.
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/admin/withdrawals/:id/reject", "admin")), true);
  for (const k of ["POST /api/v1/admin/notifications/broadcast", "POST /api/v1/auth/mfa/disable",
    "POST /api/v1/auth/password/change", "POST /api/v1/admin/withdrawals/:id/reject"]) {
    assert.equal(STEP_UP_EXEMPT.has(k), false, `${k} must not be exempt`);
  }
});

test("classification: players and marketers are never gated", () => {
  // Not a convenience: a marketer token's `sub` is a marketers.id, which is not a profiles.id, so
  // letting marketer traffic reach the session store would fail its foreign key on every request.
  assert.equal(isGatedRole("player"), false);
  assert.equal(isGatedRole("marketer"), false);
  assert.equal(isGatedRole(undefined), false);
  assert.equal(isGatedRole(null), false);
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/withdrawals", "player")), false);
  assert.equal(needsStepUp(ctxFor("POST", "/api/v1/marketers/auth/pin", "marketer")), false);
});

test("classification: every privileged tier IS gated", () => {
  for (const r of ["admin", "platform_admin", "platform_superadmin"]) {
    assert.equal(isGatedRole(r), true, r);
  }
});

test("factor: platform tiers prove possession, a site admin proves knowledge", () => {
  assert.equal(requiredFactor("admin"), "security_questions");
  assert.equal(requiredFactor("platform_admin"), "totp");
  assert.equal(requiredFactor("platform_superadmin"), "totp");
});

// ─────────────────────────── iat handling ───────────────────────────

test("tokenIatSeconds: a token with no usable iat yields null (fails closed downstream)", () => {
  assert.equal(tokenIatSeconds({ raw: { iat: 1700000000 } }), 1700000000);
  assert.equal(tokenIatSeconds({ raw: { iat: 1700000000.7 } }), 1700000000);
  assert.equal(tokenIatSeconds({ raw: {} }), null);
  assert.equal(tokenIatSeconds({ raw: { iat: "1700000000" } }), null);
  assert.equal(tokenIatSeconds({ raw: { iat: Number.NaN } }), null);
  assert.equal(tokenIatSeconds(undefined), null);
});

// ─────────────────────────── the middleware, end to end ───────────────────────────

function deps(session: PrivilegedSession | null, nowMs: number) {
  const touched: Array<[string, number]> = [];
  return {
    touched,
    gate: {
      getSession: async () => session,
      touchSession: async (u: string, i: number) => { touched.push([u, i]); },
      now: () => nowMs,
    },
  };
}

test("requireStepUp: refuses a critical action with no proof, allows it with a fresh one", async () => {
  const now = 1_000_000_000;
  const iat = Math.floor((now - 10 * S) / 1000);

  const cold = deps(sess(now - S, null), now);
  await assert.rejects(
    () => Promise.resolve(requireStepUp(cold.gate)(ctxFor("POST", "/api/v1/admin/wallets/:id/adjust", "admin", iat))),
    (e: unknown) => e instanceof ApiError && e.code === "STEP_UP_REQUIRED" && e.status === 403,
  );

  const warm = deps(sess(now - S, now - S), now);
  await requireStepUp(warm.gate)(ctxFor("POST", "/api/v1/admin/wallets/:id/adjust", "admin", iat));
});

test("requireStepUp: a routine route needs no proof, and costs no DB read", async () => {
  const now = 1_000_000_000;
  let reads = 0;
  const gate = {
    getSession: async () => { reads++; return null; },
    touchSession: async () => {},
    now: () => now,
  };
  await requireStepUp(gate)(ctxFor("POST", "/api/v1/tickets", "admin", Math.floor(now / 1000)));
  assert.equal(reads, 0, "a routine route must not hit the session store");
});

test("requireStepUp: a token with no iat cannot be tied to a session, so it is refused", async () => {
  const now = 1_000_000_000;
  const { gate } = deps(sess(now, now), now);
  await assert.rejects(
    () => Promise.resolve(requireStepUp(gate)(ctxFor("POST", "/api/v1/admin/wallets/:id/adjust", "admin"))),
    (e: unknown) => e instanceof ApiError && e.code === "SESSION_IDLE",
  );
});

test("idle gate: refuses an idle session, and does NOT refresh it on the way out", async () => {
  const now = 1_000_000_000;
  const iat = Math.floor((now - 60 * 60 * S) / 1000);
  const d = deps(sess(now - 10 * 60 * S, now), now);
  await assert.rejects(
    () => makeIdleGate(d.gate)("u1", "admin", iat),
    (e: unknown) => e instanceof ApiError && e.code === "SESSION_IDLE" && e.status === 401,
  );
  assert.deepEqual(d.touched, [], "a refused request must not keep a dead session alive");
});

test("idle gate: an active session is allowed and its last-seen stamp is refreshed", async () => {
  const now = 1_000_000_000;
  const iat = Math.floor((now - 60 * 60 * S) / 1000);
  const d = deps(sess(now - 30 * S, null), now);
  await makeIdleGate(d.gate)("u1", "admin", iat);
  assert.deepEqual(d.touched, [["u1", iat]]);
});

test("idle gate: player and marketer tokens do no work at all", async () => {
  const now = 1_000_000_000;
  let reads = 0;
  const gate = {
    getSession: async () => { reads++; return null; },
    touchSession: async () => { reads++; },
    now: () => now,
  };
  for (const role of ["player", "marketer", undefined]) {
    await makeIdleGate(gate)("u1", role, Math.floor((now - 9e6) / 1000));
  }
  assert.equal(reads, 0, "non-privileged traffic must not touch the privileged session store");
});
