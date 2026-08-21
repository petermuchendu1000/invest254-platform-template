import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

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

    // Wrong answer → 401 mismatch.
    let res = await req(api, "POST", "/api/v1/auth/password/reset", {
      body: { phone: ADMIN.phone, new_password: "NewPass123", answers: [ANSWERS[0], ANSWERS[1], { key: "first_school", answer: "nope" }] },
    });
    assert.equal(res.status, 401);
    assert.equal((await json(res)).error.code, "SECURITY_ANSWERS_MISMATCH");

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

test("privileged reset fails CLOSED (403) before answers are set; reset-questions stays empty (anti-enumeration)", async () => {
  const api = await startTestApi();
  try {
    await makeAdmin(api); // admin, but no answers set yet

    const q = await json(await req(api, "POST", "/api/v1/auth/password/reset-questions", { body: { phone: ADMIN.phone } }));
    assert.deepEqual(q.keys, []); // no answers → nothing disclosed

    const res = await req(api, "POST", "/api/v1/auth/password/reset", { body: { phone: ADMIN.phone, new_password: "NewPass123" } });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "SECURITY_QUESTIONS_NOT_SET");
  } finally { await api.close(); }
});

test("reset-questions returns empty for a player phone (no enumeration of privilege)", async () => {
  const api = await startTestApi();
  try {
    await req(api, "POST", "/api/v1/auth/register", { body: { phone: "0700000000", username: "player1", password: "Password1" } });
    const q = await json(await req(api, "POST", "/api/v1/auth/password/reset-questions", { body: { phone: "0700000000" } }));
    assert.deepEqual(q.keys, []);
  } finally { await api.close(); }
});
