import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Admin-console BRAND ISOLATION end-to-end coverage (the "data pollution" fix).
 *
 * The bug: the admin *aggregate* reads (overview KPIs, daily/user/day finance reports, RTP monitor,
 * seeds, affiliate payouts) were GLOBAL — a brand-scoped admin saw every brand's numbers summed
 * together. The list reads were already site-scoped; these aggregates were not.
 *
 * These tests drive the real HTTP API (createApp + real AdminService over the in-memory repos) and
 * assert the two invariants for every aggregate:
 *   ISOLATION — a brand-scoped admin (role < platform_superadmin, `site` claim = its brand) sees ONLY
 *               its own brand's figures.
 *   ROLLUP    — a platform_superadmin (no `site` claim) sees the cross-brand global total.
 *
 * Token scheme (testutil stub verifier): `<userId>:<role>:<site>`.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const get = (api: TestApi, path: string, token?: string) => req(api, "GET", path, token ? { token } : {});

// Player tokens that make brand-scoped deposits.
const PLAYER_A = TEST_USER;                          // legacy => default brand A
const PLAYER_B = `${TEST_USER}:player:${SITE_B}`;    // brand-B scoped player

// Admin tokens: a brand-A admin, a brand-B admin, and the cross-brand platform owner.
const ADMIN_A = `${TEST_ADMIN}:admin:${SITE_A}`;
const ADMIN_B = `${TEST_ADMIN}:admin:${SITE_B}`;
const ADMIN_PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
// A RAW platform admin (platform claim, NO site claim) — must be kept OUT of the site back office.
const ADMIN_RAW_PLATFORM = `${TEST_ADMIN}:platform_admin`;

const stkOk = (checkoutRequestId: string, receipt: string) => ({
  Body: { stkCallback: {
    CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: "ok",
    CallbackMetadata: { Item: [{ Name: "Amount", Value: 1 }, { Name: "MpesaReceiptNumber", Value: receipt }] },
  } },
});

/** Drive a full deposit: POST /deposits (brand token) -> STK callback via that brand's /s/<slug>. */
async function deposit(api: TestApi, token: string, slug: string, amount: number, receipt: string) {
  const dep = await req(api, "POST", "/api/v1/deposits", { token, body: { amount, phone: "0712345678" } });
  assert.equal(dep.status, 202, "deposit accepted");
  const { checkoutRequestId } = await json(dep);
  const cb = await req(api, "POST", `/api/v1/s/${slug}/deposits/mpesa/callback`, { body: stkOk(checkoutRequestId, receipt) });
  assert.equal(cb.status, 200, "slug-prefixed STK callback acked");
}

// ────────────────────────────── overview KPI isolation ──────────────────────────────

test("E2E isolation: /admin/overview finance is scoped to the admin's brand; platform sees the rollup", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    await deposit(api, PLAYER_A, "invest254", 40_000, "RA-DEP");
    await deposit(api, PLAYER_B, "brandb",     25_000, "RB-DEP");

    const ovA = await json(await get(api, "/api/v1/admin/overview", ADMIN_A));
    const ovB = await json(await get(api, "/api/v1/admin/overview", ADMIN_B));
    const ovP = await json(await get(api, "/api/v1/admin/overview", ADMIN_PLATFORM));

    assert.equal(ovA.finance.depositsCents, 40_000, "brand-A admin sees ONLY brand-A deposits");
    assert.equal(ovB.finance.depositsCents, 25_000, "brand-B admin sees ONLY brand-B deposits");
    assert.equal(ovP.finance.depositsCents, 65_000, "platform admin sees the cross-brand total");
  } finally { await api.close(); }
});

// ────────────────────────────── daily / day / user report isolation ──────────────────────────────

test("E2E isolation: finance reports (daily/day/users) are brand-scoped; platform is global", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    await deposit(api, PLAYER_A, "invest254", 40_000, "RA-DEP");
    await deposit(api, PLAYER_B, "brandb",     25_000, "RB-DEP");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });

    // reports/day
    const dayA = await json(await get(api, `/api/v1/admin/reports/day?date=${today}`, ADMIN_A));
    const dayB = await json(await get(api, `/api/v1/admin/reports/day?date=${today}`, ADMIN_B));
    const dayP = await json(await get(api, `/api/v1/admin/reports/day?date=${today}`, ADMIN_PLATFORM));
    assert.equal(dayA.deposits.amountCents, 40_000, "day report: brand A only");
    assert.equal(dayB.deposits.amountCents, 25_000, "day report: brand B only");
    assert.equal(dayP.deposits.amountCents, 65_000, "day report: platform rollup");

    // reports/daily (sum the deposit column across returned days)
    const sumDaily = (rows: any[]) => rows.reduce((s, r) => s + r.depositsCents, 0);
    const dailyA = await json(await get(api, "/api/v1/admin/reports/daily", ADMIN_A));
    const dailyB = await json(await get(api, "/api/v1/admin/reports/daily", ADMIN_B));
    const dailyP = await json(await get(api, "/api/v1/admin/reports/daily", ADMIN_PLATFORM));
    assert.equal(sumDaily(dailyA.items), 40_000, "daily report: brand A only");
    assert.equal(sumDaily(dailyB.items), 25_000, "daily report: brand B only");
    assert.equal(sumDaily(dailyP.items), 65_000, "daily report: platform rollup");

    // reports/users — brand admin must never see the other brand's rows
    const usersA = await json(await get(api, "/api/v1/admin/reports/users", ADMIN_A));
    const usersB = await json(await get(api, "/api/v1/admin/reports/users", ADMIN_B));
    assert.equal(usersA.items.reduce((s: number, r: any) => s + r.depositsCents, 0), 40_000, "user report: brand A only");
    assert.equal(usersB.items.reduce((s: number, r: any) => s + r.depositsCents, 0), 25_000, "user report: brand B only");
  } finally { await api.close(); }
});

// ────────────────────────────── no cross-brand leakage in the raw payloads ──────────────────────────────

test("E2E isolation: a brand-A admin's aggregate payloads never contain brand-B's amounts", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    await deposit(api, PLAYER_A, "invest254", 40_000, "RA-DEP");
    await deposit(api, PLAYER_B, "brandb",     25_000, "RB-DEP");

    const ovA = await json(await get(api, "/api/v1/admin/overview", ADMIN_A));
    // Brand-B's unique deposit amount (25_000) must not surface anywhere in brand A's dashboard.
    assert.ok(!JSON.stringify(ovA.finance).includes("25000"), "no brand-B deposit leaks into brand-A overview finance");
    assert.equal(ovA.finance.depositsCents, 40_000);
  } finally { await api.close(); }
});

// ───────────────────────────── deposit reconciliation isolation (Issue 1 leak fix) ─────────────
// The bug: GET /admin/deposits/reconcile aggregated deposits across EVERY brand (no site filter),
// so a brand-scoped admin saw other brands' deposit summary + stale list. Now site-scoped.

test("E2E isolation: /admin/deposits/reconcile is brand-scoped; platform sees the rollup", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    await deposit(api, PLAYER_A, "invest254", 40_000, "RA-DEP");
    await deposit(api, PLAYER_B, "brandb",     25_000, "RB-DEP");

    const sumAmt = (r: any) => (r.summary as any[]).reduce((s, b) => s + b.amountCents, 0);
    const recA = await json(await get(api, "/api/v1/admin/deposits/reconcile", ADMIN_A));
    const recB = await json(await get(api, "/api/v1/admin/deposits/reconcile", ADMIN_B));
    const recP = await json(await get(api, "/api/v1/admin/deposits/reconcile", ADMIN_PLATFORM));

    assert.equal(sumAmt(recA), 40_000, "reconcile summary: brand A only");
    assert.equal(sumAmt(recB), 25_000, "reconcile summary: brand B only");
    assert.equal(sumAmt(recP), 65_000, "reconcile summary: platform rollup");
    // Brand-B's unique amount must never appear anywhere in brand-A's reconcile payload.
    assert.ok(!JSON.stringify(recA).includes("25000"), "no brand-B deposit leaks into brand-A reconcile");
  } finally { await api.close(); }
});

// ───────── residual hardening: a RAW platform_admin has no site back office (Issue 1) ───────────
// adminScopeSite() is null (unrestricted) for a platform_admin and assertTargetSiteInScope() is
// null-tolerant, so admitting a raw platform_admin token to the /admin finance/aggregate surface
// would expose (and let them act on) EVERY platform. They must use the console + impersonation
// (which mints an `admin`+site token). requireSiteAdmin refuses the raw token with 403.

test("E2E hardening: a raw platform_admin is denied the /admin finance surface; site admin + owner pass", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const guarded = [
      "/api/v1/admin/overview",            // app.admin.ts
      "/api/v1/admin/deposits/reconcile",  // app.admin.ts (the reconcile leak)
      "/api/v1/admin/reports/daily",       // app.admin.ts
      "/api/v1/admin/affiliate/payouts",   // app.affiliate.ts
    ];
    for (const path of guarded) {
      const r = await get(api, path, ADMIN_RAW_PLATFORM);
      assert.equal(r.status, 403, `raw platform_admin must be blocked on ${path}`);
      const body = await json(r);
      assert.equal(body.error?.code, "PLATFORM_ADMIN_NO_SITE_BACKOFFICE", `correct denial code on ${path}`);
    }
    // The legitimate operators still get in (impersonation issues an `admin`+site token like ADMIN_A).
    assert.equal((await get(api, "/api/v1/admin/overview", ADMIN_A)).status, 200, "site admin still admitted");
    assert.equal((await get(api, "/api/v1/admin/overview", ADMIN_PLATFORM)).status, 200, "system owner still admitted");
  } finally { await api.close(); }
});
