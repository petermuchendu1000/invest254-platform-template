import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

// e2e coverage for the admin BULK action endpoints (withdrawals / affiliate payouts / marketers):
// multi-item apply, partial success (one bad id fails only its row), idempotency, auth + validation.

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
async function register(api: TestApi, phone: string, username: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username, password: "Password1", ...body } });
  assert.equal(res.status, 201, `register ${username} -> ${res.status}`);
  return (await json(res)).userId as string;
}

const ADMIN = `${TEST_ADMIN}:admin`;

// ───────────────────────────────── withdrawals bulk ─────────────────────────────────
test("POST /admin/withdrawals/bulk: multi-approve, partial success, idempotent, auth+validation", async () => {
  const api = await startTestApi({ startingBalanceCents: 5_000_000 });
  try {
    const w1 = await json(await req(api, "POST", "/api/v1/withdrawals", { token: TEST_USER, body: { amount: 300_000, phone: "0712345678" } }));
    const w2 = await json(await req(api, "POST", "/api/v1/withdrawals", { token: TEST_USER, body: { amount: 400_000, phone: "0712345678" } }));
    const id1 = w1.transactionId as string, id2 = w2.transactionId as string;
    assert.ok(id1 && id2, "withdrawals created");

    // auth: a player cannot bulk-moderate
    assert.equal((await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: TEST_USER, body: { action: "approve", txIds: [id1] } })).status, 403);
    // validation: empty ids + bad action
    assert.equal((await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: ADMIN, body: { action: "approve", txIds: [] } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: ADMIN, body: { action: "nope", txIds: [id1] } })).status, 400);

    // bulk approve both + a bogus id. Approve is TOLERANT: an unknown/non-pending tx is a safe
    // no-op (row ok:true, approved:false), not a hard error — so all rows succeed at the row level.
    const res = await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: ADMIN, body: { action: "approve", txIds: [id1, id2, "bogus-id", id1] } });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.total, 3, "dedup drops the repeat id");
    assert.equal(body.okCount, 3);
    assert.equal(body.results.find((r: any) => r.id === id1).result.approved, true, "a real pending row is approved");
    assert.equal(body.results.find((r: any) => r.id === "bogus-id").result.approved, false, "unknown id is a safe no-op");

    // idempotent: re-approving an already-approved withdrawal succeeds at the row level with approved:false
    const again = await json(await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: ADMIN, body: { action: "approve", txIds: [id1] } }));
    assert.equal(again.okCount, 1);
    assert.equal(again.results[0].result.approved, false);
  } finally { await api.close(); }
});

test("POST /admin/withdrawals/bulk reject: returns funds, partial success", async () => {
  const api = await startTestApi({ startingBalanceCents: 5_000_000 });
  try {
    const w1 = await json(await req(api, "POST", "/api/v1/withdrawals", { token: TEST_USER, body: { amount: 300_000, phone: "0712345678" } }));
    const res = await json(await req(api, "POST", "/api/v1/admin/withdrawals/bulk", { token: ADMIN, body: { action: "reject", txIds: [w1.transactionId, "bogus"] } }));
    assert.equal(res.okCount, 1);
    assert.equal(res.failCount, 1);
    assert.equal(res.results.find((r: any) => r.id === w1.transactionId).result.reversed, true);
  } finally { await api.close(); }
});

// ───────────────────────────────── affiliate payouts bulk ─────────────────────────────────
async function seedPayout(api: TestApi, affPhone: string, refPhone: string, affName: string, refName: string): Promise<{ affId: string; payoutId: string; amountCents: number }> {
  const affId = await register(api, affPhone, affName);
  const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
  const refId = await register(api, refPhone, refName, { referral_code: code });
  api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500); // GGR 7500 -> commission 1500
  await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });
  const payout = await json(await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` }));
  return { affId, payoutId: payout.payoutId, amountCents: payout.amountCents };
}

test("POST /admin/affiliate/payouts/bulk approve: multi, partial success, auth+validation", async () => {
  const api = await startTestApi();
  try {
    const p1 = await seedPayout(api, "0712345678", "0722333444", "aff1", "ref1");
    const p2 = await seedPayout(api, "0713000000", "0724000000", "aff2", "ref2");

    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: "0722333444", body: { action: "approve", payoutIds: [p1.payoutId] } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "approve", payoutIds: [] } })).status, 400);

    const res = await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "approve", payoutIds: [p1.payoutId, p2.payoutId, "bogus"] } });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.okCount, 2);
    assert.equal(body.failCount, 1);
    assert.equal(body.results.find((r: any) => r.id === p1.payoutId).result.approved, true);
  } finally { await api.close(); }
});

test("POST /admin/affiliate/payouts/bulk reject: releases hold", async () => {
  const api = await startTestApi();
  try {
    const p1 = await seedPayout(api, "0712345678", "0722333444", "aff1", "ref1");
    const body = await json(await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "reject", payoutIds: [p1.payoutId] } }));
    assert.equal(body.okCount, 1);
    assert.equal(body.results[0].result.rejected, true);
  } finally { await api.close(); }
});

// ───────────────────────────────── marketers bulk ─────────────────────────────────
test("POST /admin/marketers/bulk: status + credit, partial success, idempotency, auth+validation", async () => {
  const api = await startTestApi();
  try {
    const m1 = await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Alpha", phone: "0700000001" } }));
    const m2 = await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name: "Beta", phone: "0700000002" } }));

    // auth + validation
    assert.equal((await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: TEST_USER, body: { action: "suspend", marketerIds: [m1.id] } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "nope", marketerIds: [m1.id] } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "credit", marketerIds: [m1.id] } })).status, 400); // missing amount

    // bulk suspend both + bogus -> partial success, and the status really changed
    const susp = await json(await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "suspend", marketerIds: [m1.id, m2.id, "bogus"] } }));
    assert.equal(susp.okCount, 2);
    assert.equal(susp.failCount, 1);
    assert.equal((await json(await req(api, "GET", `/api/v1/admin/marketers/${m1.id}`, { token: ADMIN }))).status, "suspended");

    // reactivate
    const act = await json(await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "activate", marketerIds: [m1.id, m2.id] } }));
    assert.equal(act.okCount, 2);
    assert.equal((await json(await req(api, "GET", `/api/v1/admin/marketers/${m1.id}`, { token: ADMIN }))).status, "active");

    // bulk credit with a batch ref -> per-marketer idempotency key
    const cr = await json(await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "credit", amountCents: 5000, ref: "bonus-aug", marketerIds: [m1.id, m2.id] } }));
    assert.equal(cr.okCount, 2);
    assert.equal(cr.results.find((r: any) => r.id === m1.id).result.balanceCents, 5000);
    // re-run the SAME batch ref -> idempotent, balance unchanged (no double credit)
    const cr2 = await json(await req(api, "POST", "/api/v1/admin/marketers/bulk", { token: ADMIN, body: { action: "credit", amountCents: 5000, ref: "bonus-aug", marketerIds: [m1.id, m2.id] } }));
    assert.equal(cr2.results.find((r: any) => r.id === m1.id).result.balanceCents, 5000);
  } finally { await api.close(); }
});
