import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

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

async function register(api: TestApi, phone: string, username: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username, password: "Password1", ...body } });
  assert.equal(res.status, 201, `register ${username} -> ${res.status}`);
  return (await json(res)).userId as string;
}

// ───────────────────────────────────────────── enroll ─────────────────────────────────────────
test("POST /affiliate/enroll → 200 mints a code, promotes to marketer, is idempotent", async () => {
  const api = await startTestApi();
  try {
    const userId = await register(api, "0712345678", "alice");

    const res = await req(api, "POST", "/api/v1/affiliate/enroll", { token: userId });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(typeof body.referralCode, "string");
    assert.equal(body.referralCode.length, 8);
    assert.equal(body.commissionRate, 0.2);
    assert.equal(body.status, "active");
    assert.equal(body.role, "marketer");
    assert.equal(body.referralPath, `/r/${body.referralCode}`);

    const again = await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: userId }));
    assert.equal(again.referralCode, body.referralCode); // idempotent, stable code
  } finally { await api.close(); }
});

test("POST /affiliate/enroll → 401 without a bearer token", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/affiliate/enroll");
    assert.equal(res.status, 401);
  } finally { await api.close(); }
});

// ─────────────────────────────────────────── attribution ──────────────────────────────────────
test("POST /auth/register with referral_code attributes the new account (first-touch)", async () => {
  const api = await startTestApi();
  try {
    const affId = await register(api, "0712345678", "marketer");
    const enroll = await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }));
    const code: string = enroll.referralCode;

    const referredId = await register(api, "0722333444", "referred", { referral_code: code.toLowerCase() });
    assert.equal(api.identity.referredByOf(referredId), affId);
    assert.equal(api.identity.referralCount(affId), 1);

    const organicId = await register(api, "0733444555", "organic");
    assert.equal(api.identity.referredByOf(organicId), null);
  } finally { await api.close(); }
});

test("POST /auth/register → 400 INVALID_REFERRAL_CODE on a malformed code", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/auth/register", {
      body: { phone: "0712345678", username: "bob", password: "Password1", referral_code: "bad" },
    });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "INVALID_REFERRAL_CODE");
  } finally { await api.close(); }
});

// ─────────────────────────────────────── accrual (admin) ──────────────────────────────────────
test("POST /admin/affiliate/accrue: admin only, accrues 20% of referred GGR", async () => {
  const api = await startTestApi();
  try {
    const affId = await register(api, "0712345678", "marketer");
    const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
    const refId = await register(api, "0722333444", "referred", { referral_code: code });
    api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500); // GGR 7500 -> commission 1500

    // a plain player cannot accrue
    const forbidden = await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: refId, body: { date: "2026-06-10" } });
    assert.equal(forbidden.status, 403);

    // missing date -> 400
    const bad = await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: {} });
    assert.equal(bad.status, 400);

    // admin succeeds
    const ok = await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });
    assert.equal(ok.status, 200);
    const body = await json(ok);
    assert.equal(body.buckets, 1);
    assert.equal(body.totalCommissionCents, 1500);
  } finally { await api.close(); }
});

test("POST /admin/affiliate/accrue: optional `site` scopes the accrual and is validated (docs/22 Task B)", async () => {
  const api = await startTestApi();
  try {
    const admin = `${TEST_ADMIN}:admin`;
    // A brand id is accepted and echoed back (the site-scoped accrual path).
    const scoped = await req(api, "POST", "/api/v1/admin/affiliate/accrue",
      { token: admin, body: { date: "2026-06-10", site: "00000000-0000-0000-0000-000000000001" } });
    assert.equal(scoped.status, 200);
    assert.equal((await json(scoped)).site, "00000000-0000-0000-0000-000000000001");
    // Omitting site => all-brands accrual (site echoed as null).
    const all = await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: admin, body: { date: "2026-06-10" } });
    assert.equal((await json(all)).site, null);
    // A non-string site is rejected.
    const bad = await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: admin, body: { date: "2026-06-10", site: 123 } });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, "VALIDATION");
  } finally { await api.close(); }
});

// ─────────────────────────────────── dashboard reads (I3) ─────────────────────────────────────
test("GET /affiliate/summary + referrals + commissions: marketer-gated dashboard", async () => {
  const api = await startTestApi();
  try {
    const affId = await register(api, "0712345678", "marketer");
    const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
    const refId = await register(api, "0722333444", "referred", { referral_code: code });
    api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500); // GGR 7500 -> commission 1500
    await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });

    // a plain player cannot see the dashboard
    assert.equal((await req(api, "GET", "/api/v1/affiliate/summary", { token: refId })).status, 403);

    const s = await json(await req(api, "GET", "/api/v1/affiliate/summary", { token: `${affId}:marketer` }));
    assert.equal(s.totalReferrals, 1);
    assert.equal(s.turnoverCents, 10000);
    assert.equal(s.ggrCents, 7500);
    assert.equal(s.commissionAccruedCents, 1500);
    assert.equal(s.availableCents, 1500);
    assert.equal(s.referralCode, code);

    const refs = await json(await req(api, "GET", "/api/v1/affiliate/referrals", { token: `${affId}:marketer` }));
    assert.equal(refs.items.length, 1);
    assert.equal(refs.items[0].username, "referred");
    assert.equal(refs.items[0].lifetimeGgrCents, 7500);
    assert.ok("nextCursor" in refs);

    const coms = await json(await req(api, "GET", "/api/v1/affiliate/commissions", { token: `${affId}:marketer` }));
    assert.equal(coms.items.length, 1);
    assert.equal(coms.items[0].commissionCents, 1500);
    assert.equal(coms.items[0].period, "2026-06-10");
  } finally { await api.close(); }
});

// ───────────────────────────────────────── payouts (I4) ─────────────────────────────────────

/** Enroll a marketer + referred player, accrue one day, and return the marketer id + commission. */
async function seedAccrued(api: TestApi): Promise<{ affId: string; commissionCents: number }> {
  const affId = await register(api, "0712345678", "marketer");
  const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
  const refId = await register(api, "0722333444", "referred", { referral_code: code });
  api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500); // GGR 7500 -> commission 1500
  await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });
  return { affId, commissionCents: 1500 };
}

/** Build a Daraja B2C Result payload (resultCode 0 = success). */
function b2cResult(resultCode: number, conversationId = "conv-1", receipt = "RCT1") {
  return {
    Result: {
      ResultCode: resultCode, ResultDesc: resultCode === 0 ? "Success" : "Failed", ConversationID: conversationId,
      ResultParameters: { ResultParameter: [{ Key: "TransactionReceipt", Value: receipt }] },
    },
  };
}

test("payout lifecycle: marketer requests, finance-admin approves (B2C), B2C result marks paid", async () => {
  const api = await startTestApi();
  try {
    const { affId, commissionCents } = await seedAccrued(api);

    // marketer requests -> 201 with the reserved amount
    const reqRes = await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` });
    assert.equal(reqRes.status, 201);
    const payout = await json(reqRes);
    assert.equal(payout.amountCents, commissionCents);
    assert.equal(typeof payout.payoutId, "string");

    // available drops to 0 while the payout is in flight; accrued unchanged
    const s1 = await json(await req(api, "GET", "/api/v1/affiliate/summary", { token: `${affId}:marketer` }));
    assert.equal(s1.commissionAccruedCents, commissionCents);
    assert.equal(s1.availableCents, 0);

    // a plain player cannot request a payout
    const refToken = "0722333444"; // not a marketer
    assert.equal((await req(api, "POST", "/api/v1/affiliate/payouts", { token: refToken })).status, 403);

    // finance-admin approves -> B2C dispatched (stub conversation id)
    const apprRes = await req(api, "POST", `/api/v1/admin/affiliate/payouts/${payout.payoutId}/approve`, { token: `${affId}:admin` });
    assert.equal(apprRes.status, 200);
    const appr = await json(apprRes);
    assert.equal(appr.approved, true);
    assert.ok(appr.conversationId);

    // a marketer cannot approve
    assert.equal((await req(api, "POST", `/api/v1/admin/affiliate/payouts/${payout.payoutId}/approve`, { token: `${affId}:marketer` })).status, 403);

    // Daraja B2C result (success) -> paid; callback always acks
    const cbRes = await req(api, "POST", `/api/v1/affiliate/payouts/mpesa/result/${payout.payoutId}`, { body: b2cResult(0) });
    assert.equal(cbRes.status, 200);
    assert.equal((await json(cbRes)).ResultCode, 0);

    const s2 = await json(await req(api, "GET", "/api/v1/affiliate/summary", { token: `${affId}:marketer` }));
    assert.equal(s2.commissionPaidCents, commissionCents);
    assert.equal(s2.commissionAccruedCents, 0);
    assert.equal(s2.availableCents, 0);
  } finally { await api.close(); }
});

test("payout: request with nothing available -> 409; reject releases the reservation", async () => {
  const api = await startTestApi();
  try {
    // enrolled marketer with no accrued commission
    const affId = await register(api, "0712345678", "marketer");
    await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId });
    const empty = await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` });
    assert.equal(empty.status, 409);
    assert.equal((await json(empty)).error.code, "NO_AVAILABLE_COMMISSION");

    // now accrue + request, then admin rejects (pre-dispatch) -> availability restored
    const refId = await register(api, "0722333444", "referred", { referral_code: (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode });
    api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500);
    await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });
    const payout = await json(await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` }));

    const rej = await req(api, "POST", `/api/v1/admin/affiliate/payouts/${payout.payoutId}/reject`, { token: `${affId}:admin` });
    assert.equal(rej.status, 200);
    assert.equal((await json(rej)).rejected, true);

    const s = await json(await req(api, "GET", "/api/v1/affiliate/summary", { token: `${affId}:marketer` }));
    assert.equal(s.availableCents, 1500);  // released back to available
  } finally { await api.close(); }
});