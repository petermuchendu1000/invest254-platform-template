import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, makeInMemoryMarketerRepo, SITE_A, SITE_B } from "./testutil.js";
import type { InMemoryMarketerRepo } from "./testutil.js";

/**
 * Issue 3 / A1 (migration 0199): the marketer mutating RPCs gained a DB-level brand fence as a
 * backstop to the route's `marketerInScope` guard. This file proves the TWO halves that live in TS:
 *
 *  (1) WIRING — every admin marketer mutation forwards the token actor {id, role} to the repo, so the
 *      database fence (fn_assert_actor_site_scope) engages on 100% of admin calls in production; the
 *      internal/system and self-service paths forward NO actor, so the fence stays a deliberate no-op.
 *
 *  (2) FENCE SEMANTICS — mirrored in the in-memory repo: a site-tier actor acting on another brand's
 *      marketer is refused (SITE_SCOPE_FORBIDDEN); same-brand, platform-tier, and null-actor pass.
 *
 * The authoritative behaviour against real Postgres is packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py.
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

const ADMIN_A = `u-admin:admin:${SITE_A}`;       // site admin of the default brand
const ADMIN_B = `u-adminB:admin:${SITE_B}`;      // site admin of brand B

// ── (1) WIRING: admin routes forward the token actor to the repo ─────────────────────────────────
test("A1 wiring: admin credit/pin/status/fuliza/airtime/withdraw forward the token actor", async () => {
  const api = await startTestApi();
  const mem = api.marketers as InMemoryMarketerRepo;
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN_A, body: { name: "Peter M", phone: "0722000001" } }))).id as string;

    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN_A, body: { amountCents: 500000, ref: "c1" } });
    assert.deepEqual(mem._lastActor("credit"), { id: "u-admin", role: "admin" });

    await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN_A, body: { amountCents: 1000, ref: "w1" } });
    assert.deepEqual(mem._lastActor("withdraw"), { id: "u-admin", role: "admin" });

    await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN_A, body: { pin: "4321" } });
    assert.deepEqual(mem._lastActor("setPin"), { id: "u-admin", role: "admin" });

    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/status`, { token: ADMIN_A, body: { status: "suspended" } });
    assert.deepEqual(mem._lastActor("setStatus"), { id: "u-admin", role: "admin" });

    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/fuliza`, { token: ADMIN_A, body: { amountCents: 2000 } });
    assert.deepEqual(mem._lastActor("setFuliza"), { id: "u-admin", role: "admin" });

    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/airtime`, { token: ADMIN_A, body: { amountCents: 3000 } });
    assert.deepEqual(mem._lastActor("setAirtime"), { id: "u-admin", role: "admin" });
  } finally { await api.close(); }
});

test("A1 wiring: bulk credit + bulk status forward the token actor", async () => {
  const api = await startTestApi();
  const mem = api.marketers as InMemoryMarketerRepo;
  try {
    const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN_A, body: { name: "Jane D", phone: "0722000002" } }))).id as string;
    await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN_A, body: { action: "credit", marketerIds: [id], amountCents: 1000, ref: "b" } });
    assert.deepEqual(mem._lastActor("credit"), { id: "u-admin", role: "admin" });
    await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN_A, body: { action: "suspend", marketerIds: [id] } });
    assert.deepEqual(mem._lastActor("setStatus"), { id: "u-admin", role: "admin" });
  } finally { await api.close(); }
});

test("A1 wiring: cross-brand admin is still refused at the route (marketerInScope, 403) — fence unchanged", async () => {
  const api = await startTestApi();
  try {
    // Marketer created on brand B by brand B's admin.
    const mB = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN_B, body: { name: "Other Brand", phone: "0799000001" } }))).id as string;
    // Brand A's admin may not credit / re-PIN / disable a brand B marketer.
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${mB}/credit`, { token: ADMIN_A, body: { amountCents: 1000 } })).status, 403);
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${mB}/pin`, { token: ADMIN_A, body: { pin: "1111" } })).status, 403);
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${mB}/status`, { token: ADMIN_A, body: { status: "disabled" } })).status, 403);
  } finally { await api.close(); }
});

// ── (2) FENCE SEMANTICS: the DB fence, mirrored in the in-memory repo ────────────────────────────
test("A1 fence: a site admin acting on another brand's marketer is refused (backstop)", async () => {
  const repo = makeInMemoryMarketerRepo();
  repo._setActorSite("adminA", SITE_A);   // adminA's home brand is A
  const mB = (await repo.create("Brand B Marketer", "0799000002", SITE_B)).id;

  const A = { id: "adminA", role: "admin" };
  await assert.rejects(repo.setPin(mB, "1234", A), /SITE_SCOPE_FORBIDDEN/);
  await assert.rejects(repo.setStatus(mB, "disabled", A), /SITE_SCOPE_FORBIDDEN/);
  await assert.rejects(repo.credit(mB, 1000, "x", {}, A), /SITE_SCOPE_FORBIDDEN/);
  await assert.rejects(repo.setFuliza(mB, 1000, A), /SITE_SCOPE_FORBIDDEN/);
  await assert.rejects(repo.setAirtime(mB, 1000, A), /SITE_SCOPE_FORBIDDEN/);
  await assert.rejects(repo.withdraw(mB, 1000, "y", {}, "internal", A), /SITE_SCOPE_FORBIDDEN/);
});

test("A1 fence: same-brand admin, platform tier, and null actor all pass", async () => {
  const repo = makeInMemoryMarketerRepo();
  repo._setActorSite("adminB", SITE_B);        // genuine brand-B admin
  const mB = (await repo.create("Brand B Marketer", "0799000003", SITE_B)).id;

  // Same-brand admin → allowed.
  await assert.doesNotReject(repo.setPin(mB, "1234", { id: "adminB", role: "admin" }));
  assert.equal(await repo.setStatus(mB, "active", { id: "adminB", role: "admin" }), "active");

  // Platform-tier actor is not site-fenced here (keeps its own platform checks) → allowed.
  await assert.doesNotReject(repo.setPin(mB, "5678", { id: "padmin", role: "platform_admin" }));

  // The internal/system credit (fn_marketer_game_withdraw) and the self-service PIN reset pass NO
  // actor → the fence is a deliberate no-op.
  assert.equal(await repo.credit(mB, 1000, "sys", { source: "game_withdrawal" }), 1000);
  await assert.doesNotReject(repo.setPin(mB, "9999"));

  // An owner with no registered home brand (acts across all) → allowed.
  await assert.doesNotReject(repo.credit(mB, 1000, "owner", {}, { id: "owner", role: "superadmin" }));
});
