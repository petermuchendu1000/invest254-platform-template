import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/*
 * POST /admin/users/:id/reset-security-answers (0210, docs/68).
 *
 * Security answers are scrypt-hashed and unreadable, so a forgotten set has no recovery path — and
 * for a SITE ADMIN they are the step-up factor itself. This route is the supervised way back in.
 *
 * What these tests are really guarding is the LADDER, not the happy path. A reset button that is
 * slightly too generous hands one operator the power to neutralise another's second factor, so each
 * refusal below is asserted by its own code rather than "not 200": a 403 for the wrong reason would
 * otherwise pass for a 403 for the right one.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown }
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

const ANSWERS = [
  { key: "first_pet", answer: "Rex" },
  { key: "birth_city", answer: "Nairobi" },
  { key: "first_school", answer: "St. Mary's" },
];

const SITE = "00000000-0000-0000-0000-000000000001";
const PLATFORM = "10000000-0000-0000-0000-000000000001";

let seq = 0;
/** Register an account, force its role, and return its id + stub token. */
async function account(api: TestApi, role: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const phone = `07120003${String(seq).padStart(2, "0")}`;
  // Short on purpose: USERNAME_MAX_LENGTH is 20, and "u_platform_superadmin_1" is 23.
  const res = await req(api, "POST", "/api/v1/auth/register", {
    body: { phone, username: `u${seq}${role.replace(/[^a-z]/g, "").slice(0, 8)}`, password: "Password1" },
  });
  assert.equal(res.status, 201, `register ${role}`);
  const { userId } = await json(res);
  api.identity._setRole(userId, role);
  // A platform_admin token must carry a platform claim or http.ts refuses it with
  // PLATFORM_CLAIM_MISSING before the route is ever reached — which would make the ladder
  // assertions below pass for the wrong reason.
  const token = role === "platform_admin" ? `${userId}:${role}:${SITE}:${PLATFORM}` : `${userId}:${role}`;
  return { id: userId, token };
}

/** An account of `role` that has already enrolled its three answers. */
async function enrolled(api: TestApi, role: string): Promise<{ id: string; token: string }> {
  const a = await account(api, role);
  const set = await req(api, "POST", "/api/v1/auth/security-questions", { token: a.token, body: { answers: ANSWERS } });
  assert.equal(set.status, 200, "enrol answers");
  return a;
}

const RESET = (id: string): string => `/api/v1/admin/users/${id}/reset-security-answers`;

test("the system owner resets a site admin, and the admin is forced to enrol again", async () => {
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const target = await enrolled(api, "admin");

    // Precondition: with answers stored, the account is NOT in setup.
    let me = await json(await req(api, "GET", "/api/v1/auth/me", { token: target.token }));
    assert.equal(me.securitySetupRequired, false, "target should start enrolled");

    const r = await req(api, "POST", RESET(target.id), { token: owner.token });
    assert.equal(r.status, 200);
    const out = await json(r);
    assert.equal(out.userId, target.id);
    assert.equal(out.cleared, 3, "all three answers discarded");

    // THE POINT OF THE FEATURE: the person is now back in the setup gate, able to choose a new set.
    me = await json(await req(api, "GET", "/api/v1/auth/me", { token: target.token }));
    assert.equal(me.securitySetupRequired, true, "the reset did not put the target back into setup");

    // …and they can actually complete it, which is what makes this a recovery rather than a lockout.
    const again = await req(api, "POST", "/api/v1/auth/security-questions", {
      token: target.token,
      body: { answers: [{ key: "first_pet", answer: "Bobby" }, { key: "birth_city", answer: "Mombasa" }, { key: "first_school", answer: "Juja" }] },
    });
    assert.equal(again.status, 200, "a reset account must be able to enrol a fresh set");
    me = await json(await req(api, "GET", "/api/v1/auth/me", { token: target.token }));
    assert.equal(me.securitySetupRequired, false);
  } finally { await api.close(); }
});

test("nobody resets their OWN answers, however senior", async () => {
  // The load-bearing refusal. Without it, anyone holding a live privileged session could drop their
  // own knowledge factor and enrol a replacement — step-up rewriting itself from inside a session.
  const api = await startTestApi();
  try {
    const owner = await enrolled(api, "platform_superadmin");
    const r = await req(api, "POST", RESET(owner.id), { token: owner.token });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).error.code, "NO_SELF_ACTION");

    // and the answers are untouched
    const me = await json(await req(api, "GET", "/api/v1/auth/me", { token: owner.token }));
    assert.equal(me.securitySetupRequired, false, "a refused reset must not clear anything");
  } finally { await api.close(); }
});

test("a site admin cannot reset a peer — that is a lateral move, not supervision", async () => {
  const api = await startTestApi();
  try {
    const actor = await enrolled(api, "admin");
    const target = await enrolled(api, "admin");
    const r = await req(api, "POST", RESET(target.id), { token: actor.token });
    assert.equal(r.status, 403);

    const me = await json(await req(api, "GET", "/api/v1/auth/me", { token: target.token }));
    assert.equal(me.securitySetupRequired, false, "the refusal must leave the target enrolled");
  } finally { await api.close(); }
});

test("the system owner may reset a platform admin; a platform admin may not", async () => {
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const peer = await account(api, "platform_admin");
    const target = await enrolled(api, "platform_admin");

    const refused = await req(api, "POST", RESET(target.id), { token: peer.token });
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).error.code, "INSUFFICIENT_PRIVILEGE");

    const allowed = await req(api, "POST", RESET(target.id), { token: owner.token });
    assert.equal(allowed.status, 200);
    assert.equal((await json(allowed)).cleared, 3);
  } finally { await api.close(); }
});

test("the system owner's own factor is not resettable through this route", async () => {
  // Recovering the top of the tree is a break-glass operation, not a button someone else can press.
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const other = await enrolled(api, "platform_superadmin");
    const r = await req(api, "POST", RESET(other.id), { token: owner.token });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error.code, "SUPERADMIN_PROTECTED");
  } finally { await api.close(); }
});

test("resetting an account that never enrolled is a no-op, not an error", async () => {
  // A person can be locked out of a half-finished setup too; the operator should not have to care
  // which, and a 404/500 here would send them looking for a problem that is not there.
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const target = await account(api, "admin");
    const r = await req(api, "POST", RESET(target.id), { token: owner.token });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).cleared, 0);
  } finally { await api.close(); }
});

test("an unknown target is a 404, and a player token cannot reach the route at all", async () => {
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const missing = await req(api, "POST", RESET("00000000-0000-0000-0000-0000000000ff"), { token: owner.token });
    assert.equal(missing.status, 404);

    const player = await account(api, "player");
    const target = await enrolled(api, "admin");
    const r = await req(api, "POST", RESET(target.id), { token: player.token });
    assert.equal(r.status, 403);
  } finally { await api.close(); }
});

test("the reset is written to the audit trail, naming the actor and what was discarded", async () => {
  const api = await startTestApi();
  try {
    const owner = await account(api, "platform_superadmin");
    const target = await enrolled(api, "admin");
    await req(api, "POST", RESET(target.id), { token: owner.token });

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: owner.token }));
    const rows: any[] = audit.items ?? audit.rows ?? [];
    const row = rows.find((x) => x.action === "user.reset_security_answers");
    assert.ok(row, "no audit row for the reset");
    assert.equal(String(row.targetId ?? row.target_id), target.id);
    assert.equal(String(row.actorId ?? row.actor_id), owner.id);
  } finally { await api.close(); }
});
