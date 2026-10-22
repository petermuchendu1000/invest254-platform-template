import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * Issue 1 (0198): force marketer sign-out + mandatory security questions + enforce on forgot-password.
 *
 * The marketer app is the public.marketers identity (token subject = marketers.id). These exercise:
 *   - the force-logout epoch on the marketer gate (a token minted before the epoch is refused),
 *   - setting + reading the knowledge second factor,
 *   - the self-service PIN and website-password resets, both gated by the answers, fail-closed,
 *   - the anti-enumeration decoys and the uniform RESET_UNAVAILABLE.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const ADMIN = "u-admin:admin:00000000-0000-0000-0000-000000000001";
/** A marketer bearer with an explicit iat (seconds) — the 5th stub-token segment (see stubVerifier). */
const mtokIat = (id: string, iatSec: number) => `${id}:marketer:::${iatSec}`;
/** A marketer bearer with no iat at all — a pre-0198 token in the wild. */
const mtok = (id: string) => `${id}:marketer`;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Admin onboards a marketer + PIN; returns its id. */
async function onboard(api: TestApi, name: string, phone: string, pin = "1234"): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } }))).id as string;
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin } })).status, 200);
  return id;
}

const ANSWERS = [
  { key: "first_pet", answer: "Rex" },
  { key: "birth_city", answer: "Nairobi" },
  { key: "first_school", answer: "Hill Academy" },
];

async function setAnswers(api: TestApi, id: string, answers = ANSWERS): Promise<void> {
  const res = await req(api, "POST", "/api/v1/marketers/auth/security-questions", { token: mtokIat(id, nowSec()), body: { answers } });
  assert.equal(res.status, 200, "set answers");
  assert.equal((await json(res)).set, true);
}

test("force sign-out: a marketer token minted before the force-logout epoch is refused", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Grace Field", "0799000061");
    // Fresh token works before any force-logout.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: mtokIat(id, nowSec()) })).status, 200);

    // "Force all marketers to sign out immediately" — the migration stamps this; here we drive the
    // repo directly (what the migration's UPDATE and a credential reset both do).
    await api.deps.marketers.forceLogout(id);

    // An OLD token (issued an hour ago) is now revoked...
    const old = await req(api, "GET", "/api/v1/marketers/me", { token: mtokIat(id, nowSec() - 3600) });
    assert.equal(old.status, 401);
    assert.equal((await json(old)).error.code, "SESSION_REVOKED");

    // ...and a legacy token with no iat at all fails closed (cannot prove it post-dates the epoch).
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) })).status, 401);

    // A FRESH sign-in (token issued after the epoch) is accepted again — the force-out is a one-time
    // line in the sand, not a permanent lock.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: mtokIat(id, nowSec() + 3600) })).status, 200);
  } finally { await api.close(); }
});

test("security questions: set, read own keys, and surface setup-required on /me and login", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Peter M", "0799000062");

    // Before setup, /me flags it and login echoes it.
    const meBefore = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtokIat(id, nowSec()) }));
    assert.equal(meBefore.securitySetupRequired, true);
    const login = await json(await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0799000062", pin: "1234" } }));
    assert.equal(login.securitySetupRequired, true);

    await setAnswers(api, id);

    // After setup, the flag clears and my own keys are readable (for the reset/step-up prompt).
    const meAfter = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtokIat(id, nowSec()) }));
    assert.equal(meAfter.securitySetupRequired, false);
    const mine = await json(await req(api, "GET", "/api/v1/marketers/auth/security-questions/mine", { token: mtokIat(id, nowSec()) }));
    assert.deepEqual([...mine.keys].sort(), ["birth_city", "first_pet", "first_school"]);

    // An incomplete set (< 3 distinct) is rejected as input, not stored.
    const bad = await req(api, "POST", "/api/v1/marketers/auth/security-questions",
      { token: mtokIat(id, nowSec()), body: { answers: [{ key: "first_pet", answer: "Rex" }] } });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, "SECURITY_ANSWERS_TOO_FEW");
  } finally { await api.close(); }
});

test("forgot PIN: gated by the security answers, resets the PIN, and ends the old session", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Jane Doe", "0799000063", "1234");
    await setAnswers(api, id);

    // Wrong answers -> uniform RESET_UNAVAILABLE (no distinction from a missing account).
    const wrong = await req(api, "POST", "/api/v1/marketers/auth/pin/reset",
      { body: { phone: "0799000063", newPin: "5678", answers: [{ key: "first_pet", answer: "WRONG" }, { key: "birth_city", answer: "x" }, { key: "first_school", answer: "y" }] } });
    assert.equal(wrong.status, 403);
    assert.equal((await json(wrong)).error.code, "RESET_UNAVAILABLE");
    // Old PIN still works (nothing changed).
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0799000063", pin: "1234" } })).status, 200);

    // Correct answers -> PIN reset.
    const ok = await req(api, "POST", "/api/v1/marketers/auth/pin/reset",
      { body: { phone: "0799000063", newPin: "5678", answers: ANSWERS } });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).reset, true);
    // New PIN works; old PIN is dead.
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0799000063", pin: "5678" } })).status, 200);
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0799000063", pin: "1234" } })).status, 401);

    // The reset also force-logged-out any live marketer session (a legacy no-iat token is refused).
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) })).status, 401);
  } finally { await api.close(); }
});

test("forgot PIN fails closed when no security answers are set", async () => {
  const api = await startTestApi();
  try {
    await onboard(api, "No Answers", "0799000064", "1234");
    const res = await req(api, "POST", "/api/v1/marketers/auth/pin/reset",
      { body: { phone: "0799000064", newPin: "5678", answers: ANSWERS } });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "RESET_UNAVAILABLE");
    // The PIN was untouched.
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", { body: { phone: "0799000064", pin: "1234" } })).status, 200);
  } finally { await api.close(); }
});

test("reset-questions returns the real keys only for a marketer with answers; decoys otherwise", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Deco Y", "0799000065");

    // Unknown phone -> deterministic decoys (always 3, always 200), never an error.
    const unknown = await json(await req(api, "POST", "/api/v1/marketers/auth/reset-questions", { body: { phone: "0712999999" } }));
    assert.equal(unknown.keys.length, 3);
    const unknown2 = await json(await req(api, "POST", "/api/v1/marketers/auth/reset-questions", { body: { phone: "0712999999" } }));
    assert.deepEqual(unknown.keys, unknown2.keys, "decoys are deterministic per phone");

    // A marketer with no answers also gets decoys (indistinguishable from unknown).
    const noAnswers = await json(await req(api, "POST", "/api/v1/marketers/auth/reset-questions", { body: { phone: "0799000065" } }));
    assert.equal(noAnswers.keys.length, 3);

    // After setup, the real keys are returned.
    await setAnswers(api, id);
    const real = await json(await req(api, "POST", "/api/v1/marketers/auth/reset-questions", { body: { phone: "0799000065" } }));
    assert.deepEqual([...real.keys].sort(), ["birth_city", "first_pet", "first_school"]);
  } finally { await api.close(); }
});

test("optional hard enforcement blocks actions until setup, but never /me or the setup route", async () => {
  process.env.MARKETER_SECURITY_SETUP_ENFORCED = "1";
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Enf Orced", "0799000066");
    const tok = mtokIat(id, nowSec());

    // /me stays reachable so the app can show the prompt...
    assert.equal((await req(api, "GET", "/api/v1/marketers/me", { token: tok })).status, 200);
    // ...an action route is blocked until answers are set...
    const blocked = await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: tok });
    assert.equal(blocked.status, 403);
    assert.equal((await json(blocked)).error.code, "SECURITY_SETUP_REQUIRED");
    // ...the setup route itself is NOT blocked (never a dead end)...
    await setAnswers(api, id);
    // ...and once set, the action route is allowed.
    assert.equal((await req(api, "POST", "/api/v1/marketers/me/demo-topup", { token: tok })).status, 200);
  } finally {
    delete process.env.MARKETER_SECURITY_SETUP_ENFORCED;
    await api.close();
  }
});
