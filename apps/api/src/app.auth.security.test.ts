import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";
import { totpCode } from "@invest254/shared";

/*
 * API-level coverage for the security-questions second factor (0097). The harness uses a REAL
 * AuthService over the in-memory identity repo and a stub verifier that accepts `<userId>:<role>`
 * bearer tokens, so we register a real account, promote it to admin via identity._setRole, then
 * drive the endpoints exactly as the web does.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

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

const ADMIN = { phone: "0712345678", username: "adminuser", password: "Password1" };
const ANSWERS = [
  { key: "first_pet", answer: "Rex" },
  { key: "birth_city", answer: "Nairobi" },
  { key: "first_school", answer: "St. Mary's" },
];

/** Register an account and promote it to `role` in the in-memory profile. Returns userId + a stub token. */
async function makeAdmin(api: TestApi, role = "admin") {
  const res = await req(api, "POST", "/api/v1/auth/register", { body: ADMIN });
  const { userId } = await json(res);
  api.identity._setRole(userId, role);
  return { userId, token: `${userId}:${role}` };
}

test("GET /auth/security-questions/catalog → the question catalog", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "GET", "/api/v1/auth/security-questions/catalog");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.ok(Array.isArray(body.questions) && body.questions.length >= 3);
    assert.ok(body.questions.every((q: any) => typeof q.key === "string" && typeof q.label === "string"));
  } finally { await api.close(); }
});

test("/auth/me flags securitySetupRequired for an admin, false after answers are set", async () => {
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    let me = await json(await req(api, "GET", "/api/v1/auth/me", { token }));
    assert.equal(me.role, "admin");
    assert.equal(me.securitySetupRequired, true);

    const set = await req(api, "POST", "/api/v1/auth/security-questions", { token, body: { answers: ANSWERS } });
    assert.equal(set.status, 200);
    assert.equal((await json(set)).set, true);

    me = await json(await req(api, "GET", "/api/v1/auth/me", { token }));
    assert.equal(me.securitySetupRequired, false);
  } finally { await api.close(); }
});

test("a player account never gets securitySetupRequired", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0700000000", username: "player1", password: "Password1" } });
    const { userId } = await json(res);
    const me = await json(await req(api, "GET", "/api/v1/auth/me", { token: `${userId}:player` }));
    assert.equal(me.securitySetupRequired, false);
  } finally { await api.close(); }
});

test("POST /auth/security-questions → 400 on too few / duplicate / short answers", async () => {
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    let res = await req(api, "POST", "/api/v1/auth/security-questions", { token, body: { answers: ANSWERS.slice(0, 2) } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "SECURITY_ANSWERS_TOO_FEW");

    res = await req(api, "POST", "/api/v1/auth/security-questions", { token, body: { answers: [ANSWERS[0], ANSWERS[0], ANSWERS[1]] } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "SECURITY_ANSWERS_DUPLICATE_KEY");
  } finally { await api.close(); }
});

test("reset flow: reset-questions returns keys for a set-up admin, reset succeeds with correct answers", async () => {
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    await req(api, "POST", "/api/v1/auth/security-questions", { token, body: { answers: ANSWERS } });

    const q = await json(await req(api, "POST", "/api/v1/auth/password/reset-questions", { body: { phone: ADMIN.phone } }));
    assert.deepEqual([...q.keys].sort(), ["birth_city", "first_pet", "first_school"]);

    // Wrong answer → refused, with the UNIFORM code. It used to be a distinct
    // SECURITY_ANSWERS_MISMATCH, which told an anonymous caller "this phone is an operator account
    // with its answers configured" — see the indistinguishability test below.
    let res = await req(api, "POST", "/api/v1/auth/password/reset", {
      body: { phone: ADMIN.phone, new_password: "NewPass123", answers: [ANSWERS[0], ANSWERS[1], { key: "first_school", answer: "nope" }] },
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "RESET_UNAVAILABLE");

    // Correct answers → reset.
    res = await req(api, "POST", "/api/v1/auth/password/reset", {
      body: { phone: ADMIN.phone, new_password: "NewPass123", answers: ANSWERS },
    });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).reset, true);

    // New password logs in.
    const login = await req(api, "POST", "/api/v1/auth/login", { body: { phone: ADMIN.phone, password: "NewPass123" } });
    assert.equal(login.status, 200);
  } finally { await api.close(); }
});

test("privileged reset still fails CLOSED before answers are set, with the uniform refusal", async () => {
  const api = await startTestApi();
  try {
    await makeAdmin(api); // admin, but no answers set yet

    const res = await req(api, "POST", "/api/v1/auth/password/reset", { body: { phone: ADMIN.phone, new_password: "NewPass123" } });
    assert.equal(res.status, 403);
    // Used to be SECURITY_QUESTIONS_NOT_SET, which was the single most useful answer an attacker
    // could get from this endpoint: not just "this is an operator account" but "and it has not
    // finished its security setup", ranking targets by how under-defended they are.
    assert.equal((await json(res)).error.code, "RESET_UNAVAILABLE");
  } finally { await api.close(); }
});

test("reset-questions cannot be used to tell an operator phone from any other phone", async () => {
  /**
   * THE PROPERTY, and the reason the three tests above changed shape.
   *
   * This endpoint is unauthenticated and takes an arbitrary phone number. It used to answer with
   * the real question keys for a privileged account and `[]` for everything else — so anyone could
   * walk a list of numbers and read off which ones belong to the people who approve withdrawals on
   * this platform. The route's own comment claimed anti-enumeration because it "always returns
   * 200", which was true and beside the point: the status was never the channel, the body was.
   *
   * All four cases must now be indistinguishable in SHAPE. An attacker can still submit answers
   * and be refused, which is why the refusal is uniform too (tests above).
   */
  // This test probes the endpoint six times and the reset limiter is 5/min per IP — which is
  // exactly the throttle that makes the enumeration slow rather than instant, so it is doing its
  // job. Raise it for this one harness (read at route registration, hence set before startTestApi)
  // rather than weakening the assertion to fit inside the budget.
  const prevLimit = process.env.RATE_LIMIT_RESET_PER_MIN;
  process.env.RATE_LIMIT_RESET_PER_MIN = "50";
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    await req(api, "POST", "/api/v1/auth/security-questions", { token, body: { answers: ANSWERS } });
    await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0700000000", username: "player1", password: "Password1" } });
    await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0700000001", username: "player2", password: "Password1" } });

    const keysFor = async (phone: string): Promise<string[]> =>
      (await json(await req(api, "POST", "/api/v1/auth/password/reset-questions", { body: { phone } }))).keys;

    const setUpAdmin = await keysFor(ADMIN.phone);
    const player = await keysFor("0700000000");
    const otherPlayer = await keysFor("0700000001");
    const unknown = await keysFor("0799999999");

    for (const [label, keys] of [["admin", setUpAdmin], ["player", player], ["unknown", unknown]] as const) {
      assert.equal(keys.length, 3, `${label} must return three keys, not a tell-tale empty list`);
      assert.equal(new Set(keys).size, 3, `${label} must not repeat a question`);
    }
    // The admin's are the real ones; the rest are decoys — but nothing in the response says which.
    assert.deepEqual([...setUpAdmin].sort(), ["birth_city", "first_pet", "first_school"]);

    // Deterministic per phone: asking twice must not reveal that an answer was fabricated.
    assert.deepEqual(await keysFor("0700000000"), player);
    assert.deepEqual(await keysFor("0799999999"), unknown);
    // ...and not a single fixed triple for everyone, which would be just as obvious a tell.
    assert.notDeepEqual(player, otherPlayer);
  } finally {
    await api.close();
    if (prevLimit === undefined) delete process.env.RATE_LIMIT_RESET_PER_MIN;
    else process.env.RATE_LIMIT_RESET_PER_MIN = prevLimit;
  }
});

test("/auth/me flags mfaSetupRequired for an admin, false after 2FA is enabled (enroll + confirm)", async () => {
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    let me = await json(await req(api, "GET", "/api/v1/auth/me", { token }));
    assert.equal(me.role, "admin");
    assert.equal(me.mfaSetupRequired, true, "a fresh admin must be forced to enrol 2FA");

    // Begin enrolment → secret + otpauth URI + one-time recovery codes.
    const enrollRes = await req(api, "POST", "/api/v1/auth/mfa/enroll", { token });
    assert.equal(enrollRes.status, 200);
    const enroll = await json(enrollRes);
    assert.ok(typeof enroll.secret === "string" && enroll.secret.length > 0, "enroll returns a secret");
    assert.ok(typeof enroll.otpauthUrl === "string" && enroll.otpauthUrl.startsWith("otpauth://"), "enroll returns an otpauth URI");
    assert.ok(Array.isArray(enroll.recoveryCodes) && enroll.recoveryCodes.length > 0, "enroll returns recovery codes");

    // Still required until CONFIRMED with a valid TOTP code.
    me = await json(await req(api, "GET", "/api/v1/auth/me", { token }));
    assert.equal(me.mfaSetupRequired, true, "2FA is inactive until confirmed");

    // Confirm with a code derived from the secret → 2FA active.
    const confirmRes = await req(api, "POST", "/api/v1/auth/mfa/confirm", { token, body: { code: totpCode(enroll.secret) } });
    assert.equal(confirmRes.status, 200);
    assert.equal((await json(confirmRes)).enabled, true);

    me = await json(await req(api, "GET", "/api/v1/auth/me", { token }));
    assert.equal(me.mfaSetupRequired, false, "gate clears once 2FA is enabled");
  } finally { await api.close(); }
});

test("a player account never gets mfaSetupRequired", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0700000001", username: "player2", password: "Password1" } });
    const { userId } = await json(res);
    const me = await json(await req(api, "GET", "/api/v1/auth/me", { token: `${userId}:player` }));
    assert.equal(me.mfaSetupRequired, false);
  } finally { await api.close(); }
});

test("player/marketer two-factor is switched off (enrol + confirm refused); staff are unaffected", async () => {
  for (const role of ["player", "marketer"]) {
    const api = await startTestApi();
    try {
      const { token } = await makeAdmin(api, role);
      const e = await req(api, "POST", "/api/v1/auth/mfa/enroll", { token });
      assert.equal(e.status, 403, `${role} enrol refused`);
      assert.equal((await json(e)).error.code, "PLAYER_MFA_DISABLED");
      const c = await req(api, "POST", "/api/v1/auth/mfa/confirm", { token, body: { code: "123456" } });
      assert.equal(c.status, 403, `${role} confirm refused`);
    } finally { await api.close(); }
  }
  // staff enrolment still works (covered in depth above)
  const api = await startTestApi();
  try {
    const { token } = await makeAdmin(api);
    assert.equal((await req(api, "POST", "/api/v1/auth/mfa/enroll", { token })).status, 200);
  } finally { await api.close(); }
});
