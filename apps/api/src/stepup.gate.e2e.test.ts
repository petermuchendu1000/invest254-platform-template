import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";
import { requireStepUp, type PrivilegedSession } from "./stepup.js";
import type { AuthClaims, Verifier } from "@invest254/engine";

/**
 * END-TO-END proof that the step-up gate is actually ATTACHED to the routes it claims to protect.
 *
 * stepup.test.ts proves the gate's LOGIC — which routes it classifies, how the two windows behave,
 * that a missing session record fails closed. None of that is worth anything if the middleware
 * never runs, and the way it runs is unusual: it is not written into any route's chain by hand. The
 * Router splices it in at registration time, behind the `requireAuth` marker, for every mutating
 * method. That is exactly the kind of machinery that can quietly stop working — a refactor that
 * drops the marker, a route registered another way, a `stepUp` production forgets to pass — and the
 * symptom is nothing at all: the app behaves perfectly, with ~120 critical routes unguarded.
 *
 * So these drive real HTTP through the real router and assert the challenge appears where it should
 * and stays out of the way where it must.
 *
 * The gate is OFF in the default harness on purpose (testutil.ts): switching it on for the whole
 * suite would make every test present a second factor before any write, exercising this gate 2000
 * times and the routes under test not at all. Here it is switched on deliberately.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** The error code, or "" for a success — assertions key on this rather than on the HTTP status,
 *  because several things downstream of the gate also answer 403 (scope fences, role checks) and a
 *  status-only assertion would pass for the wrong reason. */
async function code(res: Response): Promise<string> {
  if (res.status < 400) return "";
  try { return (await json(res)).error?.code ?? ""; } catch { return ""; }
}

/**
 * A verifier whose tokens carry a controllable `iat`: `<userId>|<role>|<iatSeconds>|<siteId>`.
 *
 * The shared `stubVerifier` mints `raw: {}` — no `iat` at all — which the gate correctly refuses
 * (see the first test). To exercise anything past that refusal the tests need to say when a token
 * was issued, so this is the one place that models a real JWT's `iat`.
 */
const iatVerifier: Verifier = async (token: string): Promise<AuthClaims> => {
  const [userId, role, iat, site] = token.split("|");
  if (!userId) throw new Error("TOKEN_INVALID");
  return {
    userId, role: role || "player",
    ...(site ? { site } : {}),
    raw: iat ? { iat: Number(iat) } : {},
  };
};

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return fetch(`${api.baseUrl}${path}`, init);
}

/** One in-memory session store shared by the gate and the /auth/step-up route, as production shares one. */
function sessionStore() {
  const rows = new Map<string, PrivilegedSession>();
  const key = (u: string, i: number): string => `${u}:${i}`;
  return {
    set: (u: string, i: number, s: PrivilegedSession) => rows.set(key(u, i), s),
    port: {
      getSession: async (u: string, i: number) => rows.get(key(u, i)) ?? null,
      touchSession: async (u: string, i: number) => {
        const cur = rows.get(key(u, i));
        rows.set(key(u, i), { lastSeenAtMs: Date.now(), stepUpAtMs: cur?.stepUpAtMs ?? null });
      },
      recordStepUp: async (u: string, i: number) => {
        rows.set(key(u, i), { lastSeenAtMs: Date.now(), stepUpAtMs: Date.now() });
      },
      endSessions: async (u: string) => {
        for (const k of [...rows.keys()]) if (k.startsWith(`${u}:`)) rows.delete(k);
      },
      forceLogout: async () => {},
    },
  };
}

async function gatedApi(): Promise<{ api: TestApi; store: ReturnType<typeof sessionStore> }> {
  const store = sessionStore();
  const api = await startTestApi({
    depsOverrides: { verifier: iatVerifier, stepUp: requireStepUp(store.port), privilegedSessions: store.port },
  });
  return { api, store };
}

const NOW = (): number => Math.floor(Date.now() / 1000);
const ADJUST = "/api/v1/admin/wallets/u-test/adjust";
const adjustBody = { amount_cents: 100, kind: "real", reason: "e2e" };

test("gate: a privileged token with no usable iat cannot take a critical action at all", async () => {
  const { api } = await gatedApi();
  try {
    // Nothing to tie to a session, so nothing can show it is inside the idle window. Fails closed.
    const res = await req(api, "POST", ADJUST, { token: "admin-user|admin", body: adjustBody });
    assert.equal(await code(res), "SESSION_IDLE");
  } finally { await api.close(); }
});

test("gate: a CRITICAL route is challenged when no second factor has been proven", async () => {
  const { api, store } = await gatedApi();
  try {
    const iat = NOW();
    // Seeded as live, so this tests the STEP-UP branch rather than the idle one.
    store.set("admin-user", iat, { lastSeenAtMs: Date.now(), stepUpAtMs: null });
    const res = await req(api, "POST", ADJUST, { token: `admin-user|admin|${iat}|${SITE_A}`, body: adjustBody });
    assert.equal(await code(res), "STEP_UP_REQUIRED");
  } finally { await api.close(); }
});

test("gate: proving the factor clears the challenge, and the proof does not travel to another token", async () => {
  const { api, store } = await gatedApi();
  try {
    const iat = NOW();
    store.set("admin-user", iat, { lastSeenAtMs: Date.now(), stepUpAtMs: Date.now() });
    let res = await req(api, "POST", ADJUST, { token: `admin-user|admin|${iat}|${SITE_A}`, body: adjustBody });
    assert.notEqual(await code(res), "STEP_UP_REQUIRED", "a freshly stepped-up session must pass the gate");

    // A DIFFERENT token for the SAME operator inherits nothing. This is what makes a stolen or
    // re-minted token useless: the proof belongs to the token that earned it.
    store.set("admin-user", iat + 1, { lastSeenAtMs: Date.now(), stepUpAtMs: null });
    res = await req(api, "POST", ADJUST, { token: `admin-user|admin|${iat + 1}|${SITE_A}`, body: adjustBody });
    assert.equal(await code(res), "STEP_UP_REQUIRED");
  } finally { await api.close(); }
});

test("gate: an EXPIRED proof is challenged again even while the session stays active", async () => {
  const { api, store } = await gatedApi();
  try {
    const iat = NOW();
    // Active one second ago, but the factor was proven well outside its window. Staying busy must
    // never renew a second factor, or one code at the start of a shift authorises the whole shift.
    store.set("admin-user", iat, { lastSeenAtMs: Date.now(), stepUpAtMs: Date.now() - 10 * 60_000 });
    const res = await req(api, "POST", ADJUST, { token: `admin-user|admin|${iat}|${SITE_A}`, body: adjustBody });
    assert.equal(await code(res), "STEP_UP_REQUIRED");
  } finally { await api.close(); }
});

test("gate: a ROUTINE mutating route is never challenged", async () => {
  const { api, store } = await gatedApi();
  try {
    const iat = NOW();
    store.set("admin-user", iat, { lastSeenAtMs: Date.now(), stepUpAtMs: null });
    // On the exempt list, so it must pass with nothing proven. If this starts failing, the exempt
    // list stopped being consulted and every operator's day just got much slower.
    const res = await req(api, "POST", "/api/v1/tickets", {
      token: `admin-user|admin|${iat}|${SITE_A}`, body: { title: "printer on fire", body: "again" },
    });
    assert.notEqual(await code(res), "STEP_UP_REQUIRED");
  } finally { await api.close(); }
});

test("gate: a GET is never challenged", async () => {
  const { api, store } = await gatedApi();
  try {
    const iat = NOW();
    store.set("admin-user", iat, { lastSeenAtMs: Date.now(), stepUpAtMs: null });
    const res = await req(api, "GET", "/api/v1/admin/overview", { token: `admin-user|admin|${iat}|${SITE_A}` });
    assert.notEqual(await code(res), "STEP_UP_REQUIRED");
  } finally { await api.close(); }
});

test("gate: a PLAYER's own mutating routes are completely unaffected", async () => {
  const { api } = await gatedApi();
  try {
    // Not a convenience. A marketer token's `sub` is a marketers.id, not a profiles.id, so letting
    // non-privileged traffic reach the privileged session store would fail its FK on every request.
    // And a player must never be asked for an authenticator code to make a deposit.
    const res = await req(api, "POST", "/api/v1/deposits", {
      token: `u-test|player|${NOW()}|${SITE_A}`, body: { amount_cents: 50_000, phone: "0712345678" },
    });
    assert.notEqual(await code(res), "STEP_UP_REQUIRED");
    assert.notEqual(await code(res), "SESSION_IDLE");
  } finally { await api.close(); }
});

test("gate: with no stepUp wired there is no challenge — pinning what the optional dep means", async () => {
  // ApiDeps.stepUp is optional so the 2000-test suite can run without it. This asserts what
  // "absent" means, so nobody later reads that optionality as "the gate may silently be off in
  // production too"; production wiring is covered by the tests above plus server.ts passing it.
  const api = await startTestApi({ depsOverrides: { verifier: iatVerifier } });
  try {
    const res = await req(api, "POST", ADJUST, { token: `admin-user|admin|${NOW()}|${SITE_A}`, body: adjustBody });
    assert.notEqual(await code(res), "STEP_UP_REQUIRED");
    assert.notEqual(await code(res), "SESSION_IDLE");
  } finally { await api.close(); }
});
