import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Referral commission PAYOUT lifecycle + guards, driven through the real HTTP API.
 * (The commission MATH itself — differential unilevel 25/20/17 + player 5% — is proven against the
 *  live schema in the DB layer; here we prove the request -> approve -> paid flow, the KES 500 floor,
 *  one-pending guard, and admin brand-scoping.)
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const MK = "mk-user";                          // a marketer on site A
const MK_TOK = `${MK}:marketer:${SITE_A}`;
const ADMIN_A = `u-admin:admin:${SITE_A}`;
const ADMIN_B = `u-admin:admin:${SITE_B}`;

test("referral: /me/referral shows commission balance + code", async () => {
  const api = await startTestApi();
  try {
    api.referral._setCode(MK, "STEVE01");
    api.referral._seedCommission(MK, 100_000, SITE_A);   // KES 1000 accrued
    const s = await json(await req(api, "GET", "/api/v1/me/referral", MK_TOK));
    assert.equal(s.referralCode, "STEVE01");
    assert.equal(s.referralPath, "/r/STEVE01");
    assert.equal(s.availableCents, 100_000);
    assert.equal(s.minPayoutCents, 50_000);
  } finally { await api.close(); }
});

test("referral: payout request enforces KES 500 floor + one-pending guard", async () => {
  const api = await startTestApi();
  try {
    api.referral._seedCommission(MK, 40_000, SITE_A);    // KES 400 < 500
    let r = await req(api, "POST", "/api/v1/me/referral/payouts", MK_TOK);
    assert.equal(r.status, 400, "below KES 500 is rejected");
    assert.equal((await json(r)).error.code, "BELOW_MIN");

    api.referral._seedCommission(MK, 60_000, SITE_A);    // now KES 1000 total
    r = await req(api, "POST", "/api/v1/me/referral/payouts", MK_TOK);
    assert.equal(r.status, 200, "at/above floor is accepted");
    assert.equal((await json(r)).amountCents, 100_000);

    r = await req(api, "POST", "/api/v1/me/referral/payouts", MK_TOK);
    assert.equal(r.status, 409, "second pending request blocked");
    assert.equal((await json(r)).error.code, "PAYOUT_PENDING");
  } finally { await api.close(); }
});

test("referral: admin approve -> mark paid lifecycle; brand isolation on the queue", async () => {
  const api = await startTestApi();
  try {
    api.referral._seedCommission(MK, 100_000, SITE_A);
    const reqd = await json(await req(api, "POST", "/api/v1/me/referral/payouts", MK_TOK));

    // Brand-A admin sees it; brand-B admin does not.
    const qA = await json(await req(api, "GET", "/api/v1/admin/commission-payouts", ADMIN_A));
    const qB = await json(await req(api, "GET", "/api/v1/admin/commission-payouts", ADMIN_B));
    assert.equal(qA.items.length, 1);
    assert.equal(qB.items.length, 0, "brand-B admin cannot see brand-A's commission payout");

    // Brand-B admin cannot act on a brand-A payout (IDOR closed).
    const bad = await req(api, "POST", `/api/v1/admin/commission-payouts/${reqd.id}/approve`, ADMIN_B);
    assert.equal(bad.status, 403);

    // Brand-A admin approves then marks paid.
    assert.equal((await json(await req(api, "POST", `/api/v1/admin/commission-payouts/${reqd.id}/approve`, ADMIN_A))).status, "approved");
    const paid = await json(await req(api, "POST", `/api/v1/admin/commission-payouts/${reqd.id}/paid`, ADMIN_A, { ref: "MPESA-QWE123" }));
    assert.equal(paid.status, "paid");
    assert.equal(paid.paidRef, "MPESA-QWE123");
  } finally { await api.close(); }
});
