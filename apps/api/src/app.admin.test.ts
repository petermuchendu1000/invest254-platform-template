import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

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

test("admin routes are role-gated: a player token is forbidden", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000001", "gateuser");
    const res = await req(api, "GET", "/api/v1/admin/overview", { token: uid }); // role defaults to player
    assert.equal(res.status, 403);
  } finally { await api.close(); }
});

test("admin lists users and reads the overview", async () => {
  const api = await startTestApi();
  try {
    await register(api, "0712000002", "user_a");
    await register(api, "0712000003", "user_b");
    const list = await req(api, "GET", "/api/v1/admin/users", { token: "admin-1:admin" });
    assert.equal(list.status, 200);
    const body = await json(list);
    assert.ok(Array.isArray(body.items) && body.items.length >= 2);
    const ov = await json(await req(api, "GET", "/api/v1/admin/overview", { token: "admin-1:admin" }));
    assert.ok(ov.users.total >= 2);
  } finally { await api.close(); }
});

test("admin suspend is applied + audited; login still works (deposits) but the account is limited", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000004", "victim");
    const ok = await req(api, "POST", "/api/v1/auth/login", { body: { phone: "0712000004", password: "Password1" } });
    assert.equal(ok.status, 200);

    const sus = await req(api, "POST", `/api/v1/admin/users/${uid}/suspend`, { token: "admin-9:admin", body: { reason: "abuse" } });
    assert.equal(sus.status, 200);
    assert.equal((await json(sus)).status, "suspended");

    // A limited account can STILL log in (so it can deposit); trading/withdrawal are gated at
    // the money layer, not at login.
    const stillIn = await req(api, "POST", "/api/v1/auth/login", { body: { phone: "0712000004", password: "Password1" } });
    assert.equal(stillIn.status, 200);

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "admin-9:admin" }));
    assert.ok(audit.items.some((a: any) => a.action === "user.status" && a.targetId === uid));
  } finally { await api.close(); }
});

test("admin cannot suspend another admin; a superadmin can", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000005", "staff");
    api.identity.adminSetRole(uid, "admin"); // target is now an admin
    const denied = await req(api, "POST", `/api/v1/admin/users/${uid}/suspend`, { token: "admin-2:admin" });
    assert.equal(denied.status, 403);
    const allowed = await req(api, "POST", `/api/v1/admin/users/${uid}/suspend`, { token: "root-1:superadmin" });
    assert.equal(allowed.status, 200);
  } finally { await api.close(); }
});

test("admin manual balance adjustment credits the wallet, requires a reason, and is audited", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000010", "adj_target");

    const credit = await req(api, "POST", `/api/v1/admin/wallets/${uid}/adjust`, { token: "fin-1:admin", body: { amountCents: 25_000, reason: "manual credit" } });
    assert.equal(credit.status, 200);
    const cb = await json(credit);
    assert.equal(cb.newBalanceCents, 25_000);
    assert.equal(cb.direction, "credit");
    assert.equal(await api.payRepo.getBalance(uid), 25_000);

    // direction:debit applies a negative adjustment regardless of magnitude sign
    const debit = await req(api, "POST", `/api/v1/admin/wallets/${uid}/adjust`, { token: "fin-1:admin", body: { amountCents: 5_000, direction: "debit", reason: "clawback" } });
    assert.equal((await json(debit)).newBalanceCents, 20_000);

    const noReason = await req(api, "POST", `/api/v1/admin/wallets/${uid}/adjust`, { token: "fin-1:admin", body: { amountCents: 1_000 } });
    assert.equal(noReason.status, 400);

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "fin-1:admin" }));
    assert.ok(audit.items.some((a: any) => a.action === "balance.adjust" && a.targetId === uid));
  } finally { await api.close(); }
});

test("admin deposits monitor lists deposits and the reconcile read returns a summary + stale list", async () => {
  const api = await startTestApi();
  try {
    const dep = await api.payRepo.createDeposit("u-test", 30_000, "254700000099");
    await api.payRepo.attachStk(dep, "m1", "chk-x"); // -> processing (non-terminal)

    const list = await json(await req(api, "GET", "/api/v1/admin/deposits", { token: "fin-1:admin" }));
    assert.ok(Array.isArray(list.items) && list.items.length >= 1);
    assert.ok(list.items.some((d: any) => d.checkoutRequestId === "chk-x" && d.status === "processing"));

    const rec = await json(await req(api, "GET", "/api/v1/admin/deposits/reconcile?staleMinutes=0", { token: "fin-1:admin" }));
    assert.equal(rec.staleMinutes, 0);
    assert.ok(Array.isArray(rec.summary));
    assert.ok(rec.stale.some((d: any) => d.checkoutRequestId === "chk-x"));
  } finally { await api.close(); }
});

test("admin reports: per-day & per-user JSON, CSV export, and the date-range filter (J4)", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000030", "reporter");
    api.payRepo.seed(uid, 0);

    // A settled play on a fixed trade-date + a success deposit (lands on "today").
    api.identity.recordSettledPlay(uid, "2026-06-10", 10_000, 2_500); // turnover 10000, ggr 7500
    const dep = await api.payRepo.createDeposit(uid, 50_000, "0712000030");
    await api.payRepo.attachStk(dep, "m", "chk-r");
    await api.payRepo.completeDeposit("chk-r", 0, "ok", "RCPT", {});
    // Day reports bucket in EAT (production PgAdminRepo uses `at time zone 'Africa/Nairobi'`; the
    // in-memory harness matches after BUGLOG #3). Use the EAT calendar date so the assertion is stable
    // across the UTC/EAT day boundary (00:00–03:00 EAT), not just during Nairobi daytime.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });

    // Per-user JSON.
    const users = (await json(await req(api, "GET", "/api/v1/admin/reports/users", { token: "admin-1:admin" }))).items as any[];
    const urow = users.find((r) => r.userId === uid)!;
    assert.equal(urow.turnoverCents, 10_000);
    assert.equal(urow.ggrCents, 7_500);
    assert.equal(urow.depositsCents, 50_000);

    // Per-day JSON: game day carries turnover/GGR; the deposit day carries the cash.
    const daily = (await json(await req(api, "GET", "/api/v1/admin/reports/daily", { token: "admin-1:admin" }))).items as any[];
    const d10 = daily.find((r) => r.date === "2026-06-10")!;
    assert.equal(d10.turnoverCents, 10_000);
    assert.equal(d10.ggrCents, 7_500);
    assert.equal(daily.find((r) => r.date === today)!.depositsCents, 50_000);

    // CSV export: content-type + header + a data row.
    const csvRes = await req(api, "GET", "/api/v1/admin/reports/daily?format=csv", { token: "admin-1:admin" });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
    const csvLines = (await csvRes.text()).trim().split("\r\n");
    assert.equal(csvLines[0], "date,deposits_cents,withdrawals_cents,turnover_cents,ggr_cents");
    assert.ok(csvLines.some((l) => l.startsWith("2026-06-10,")));

    // Date-range filter excludes the old game day.
    const filtered = (await json(await req(api, "GET", "/api/v1/admin/reports/daily?from=2030-01-01", { token: "admin-1:admin" }))).items as any[];
    assert.ok(!filtered.some((r) => r.date === "2026-06-10"));

    // Malformed date -> 400; player token -> 403.
    assert.equal((await req(api, "GET", "/api/v1/admin/reports/daily?from=2026/06/10", { token: "admin-1:admin" })).status, 400);
    assert.equal((await req(api, "GET", "/api/v1/admin/reports/daily", { token: uid })).status, 403);
  } finally { await api.close(); }
});

// ──────────────────────────────────────────────── J5: game config + RTP monitor + seed rotation ──

test("admin reports/day (calendar): comprehensive single-day stats; date-validated; role-gated", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009090", "dayuser");
    api.payRepo.seed(uid, 0);
    // A successful deposit today must surface in the day report's cash section.
    const dep = await api.payRepo.createDeposit(uid, 50_000, "0712009090");
    await api.payRepo.attachStk(dep, "m", "chk-day");
    await api.payRepo.completeDeposit("chk-day", 0, "ok", "RCPT", {});
    // UTC day matches the in-memory grouping used by the reports repo (see reports/daily test).
    // Day reports bucket in EAT (production PgAdminRepo uses `at time zone 'Africa/Nairobi'`; the
    // in-memory harness matches after BUGLOG #3). Use the EAT calendar date so the assertion is stable
    // across the UTC/EAT day boundary (00:00–03:00 EAT), not just during Nairobi daytime.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });

    const res = await req(api, "GET", `/api/v1/admin/reports/day?date=${today}`, { token: "admin-1:admin" });
    assert.equal(res.status, 200);
    const d = await json(res);
    assert.equal(d.date, today);
    assert.equal(d.deposits.count, 1);
    assert.equal(d.deposits.amountCents, 50_000);
    assert.equal(d.depositors, 1);
    // The full shape the calendar UI renders must be present as numbers (never undefined).
    for (const k of ["newRegistrants", "newMarketers", "activePlayers", "firstTimeDepositors",
      "settledPositions", "winningPositions", "turnoverCents", "payoutCents", "ggrCents",
      "commissionAccruedCents", "poolBudgetCents", "poolPaidCents"]) {
      assert.equal(typeof d[k], "number", `${k} should be a number`);
    }
    assert.equal(typeof d.withdrawals.amountCents, "number");
    assert.equal(typeof d.pendingWithdrawals.amountCents, "number");

    // Defaults to today (EAT) when no date param is supplied.
    assert.equal((await req(api, "GET", "/api/v1/admin/reports/day", { token: "admin-1:admin" })).status, 200);
    // Malformed date -> 400; player token -> 403.
    assert.equal((await req(api, "GET", "/api/v1/admin/reports/day?date=2026/06/10", { token: "admin-1:admin" })).status, 400);
    assert.equal((await req(api, "GET", "/api/v1/admin/reports/day", { token: uid })).status, 403);
  } finally { await api.close(); }
});

test("admin withdrawals queue carries full player context (balance + lifetime deposits/withdrawals)", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009191", "wduser");
    api.payRepo.seed(uid, 0);
    // Fund the player: KES 1,000 deposit -> balance 100000, lifetime deposits 100000.
    const dep = await api.payRepo.createDeposit(uid, 100_000, "0712009191");
    await api.payRepo.attachStk(dep, "m", "chk-wd");
    await api.payRepo.completeDeposit("chk-wd", 0, "ok", "RCPT-1", {});
    // Request a KES 300 withdrawal (holds funds; status pending).
    const wd = await api.payRepo.createWithdrawal(uid, 30_000, "0712009191", 25_000);

    const items = (await json(await req(api, "GET", "/api/v1/admin/withdrawals", { token: "admin-1:admin" }))).items as any[];
    const row = items.find((r) => r.txId === wd.txId);
    assert.ok(row, "withdrawal should appear in the admin queue");
    assert.equal(row.username, "wduser");
    assert.equal(row.amountCents, 30_000);
    assert.equal(row.phone, "0712009191");
    assert.equal(row.balanceCents, 70_000);        // 100000 deposited − 30000 held
    assert.equal(row.totalDepositsCents, 100_000);
    assert.equal(row.depositCount, 1);
    assert.equal(row.totalWithdrawalsCents, 0);     // this one is still pending, not paid
    assert.equal(row.withdrawalCount, 0);
    assert.equal(typeof row.firstDepositAtMs, "number");

    // Player token is forbidden.
    assert.equal((await req(api, "GET", "/api/v1/admin/withdrawals", { token: uid })).status, 403);
  } finally { await api.close(); }
});

test("admin withdrawals kill switch: role-gated toggle that blocks new withdrawals when off", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009292", "kswuser");
    api.payRepo.seed(uid, 0);
    const dep = await api.payRepo.createDeposit(uid, 100_000, "0712009292");
    await api.payRepo.attachStk(dep, "m", "chk-ksw");
    await api.payRepo.completeDeposit("chk-ksw", 0, "ok", "R-KSW", {});

    // Default: enabled. Player cannot read or toggle.
    assert.equal((await json(await req(api, "GET", "/api/v1/admin/withdrawals-enabled", { token: "admin-1:admin" }))).enabled, true);
    assert.equal((await req(api, "GET", "/api/v1/admin/withdrawals-enabled", { token: uid })).status, 403);
    assert.equal((await req(api, "PUT", "/api/v1/admin/withdrawals-enabled", { token: uid, body: { enabled: false } })).status, 403);
    // Missing/invalid body -> 400.
    assert.equal((await req(api, "PUT", "/api/v1/admin/withdrawals-enabled", { token: "admin-1:admin", body: {} })).status, 400);

    // Admin disables -> a player withdrawal request is refused (403 WITHDRAWALS_DISABLED).
    const off = await req(api, "PUT", "/api/v1/admin/withdrawals-enabled", { token: "admin-1:admin", body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal((await json(off)).enabled, false);
    const blocked = await req(api, "POST", "/api/v1/withdrawals", { token: uid, body: { amount: 30_000, phone: "0712009292" } });
    assert.equal(blocked.status, 403);
    assert.equal((await json(blocked)).error.code, "WITHDRAWALS_DISABLED");

    // Re-enable -> the same request now succeeds (202 pending).
    await req(api, "PUT", "/api/v1/admin/withdrawals-enabled", { token: "admin-1:admin", body: { enabled: true } });
    const okRes = await req(api, "POST", "/api/v1/withdrawals", { token: uid, body: { amount: 30_000, phone: "0712009292" } });
    assert.equal(okRes.status, 202);
  } finally { await api.close(); }
});

test("marketer expenses (0068): admin logs an expense; the marketer sees it (transparency); role-gated", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009393", "expmkt");
    // Admin logs two expenses against this marketer.
    const e1 = await req(api, "POST", "/api/v1/admin/affiliate/expenses", { token: "admin-1:admin", body: { marketerUserId: uid, category: "tiktok_promo", amountCents: 5_000, note: "Boost" } });
    assert.equal(e1.status, 200);
    assert.equal((await json(e1)).category, "tiktok_promo");
    await req(api, "POST", "/api/v1/admin/affiliate/expenses", { token: "admin-1:admin", body: { marketerUserId: uid, category: "advance", amountCents: 20_000 } });

    // Admin can list them (newest-first, with a total).
    const adminList = await json(await req(api, "GET", `/api/v1/admin/affiliate/expenses?marketerUserId=${uid}`, { token: "admin-1:admin" }));
    assert.equal(adminList.items.length, 2);
    assert.equal(adminList.totalCents, 25_000);

    // The marketer sees their OWN expenses (transparency).
    const mine = await json(await req(api, "GET", "/api/v1/affiliate/expenses", { token: `${uid}:marketer` }));
    assert.equal(mine.items.length, 2);
    assert.equal(mine.totalCents, 25_000);

    // Player token cannot add (admin-gated) and missing fields -> 400.
    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/expenses", { token: uid, body: { marketerUserId: uid, category: "other", amountCents: 100 } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/expenses", { token: "admin-1:admin", body: { marketerUserId: uid, amountCents: 100 } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/expenses", { token: "admin-1:admin", body: { marketerUserId: uid, category: "other", amountCents: -5 } })).status, 400);
  } finally { await api.close(); }
});

test("J5 game config: admin reads; only superadmin edits; validates; audited", async () => {
  const api = await startTestApi();
  try {
    const cfg = await json(await req(api, "GET", "/api/v1/admin/game-config", { token: "admin-1:admin" }));
    assert.equal(cfg.houseEdge, 0.75);
    assert.equal(cfg.rtpTarget, 0.25);

    // a day-to-day admin cannot edit config (superadmin only)
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "admin-1:admin", body: { houseEdge: 0.7 } })).status, 403);

    // superadmin edits a partial patch; rtpTarget is recomputed from house_edge
    const upd = await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { houseEdge: 0.7, maxStakeCents: 6_000_000 } });
    assert.equal(upd.status, 200);
    const u = await json(upd);
    assert.equal(u.houseEdge, 0.7);
    assert.ok(Math.abs(u.rtpTarget - 0.3) < 1e-9);
    assert.equal(u.maxStakeCents, 6_000_000);
    assert.equal(u.minStakeCents, 25000); // untouched key preserved

    // BUG REGRESSION (min-withdrawal config): editing ONLY the min-withdrawal floor must succeed
    // and persist. Previously `minWithdrawalCents` was missing from the API's CONFIG_FIELDS
    // allowlist, so this patch was stripped to empty and rejected with "provide at least one
    // config field to update" — the value could never be saved from the admin panel.
    const mw = await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { minWithdrawalCents: 50000 } });
    assert.equal(mw.status, 200, "editing only min withdrawal must be accepted");
    assert.equal((await json(mw)).minWithdrawalCents, 50000);
    const reread = await json(await req(api, "GET", "/api/v1/admin/game-config", { token: "admin-1:admin" }));
    assert.equal(reread.minWithdrawalCents, 50000, "min withdrawal persisted and reads back");
    // a non-integer cents value for the floor is still rejected
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { minWithdrawalCents: 250.5 } })).status, 400);

    // out-of-range value -> 400; non-integer cents -> 400; empty patch -> 400
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { houseEdge: 1.5 } })).status, 400);
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { minStakeCents: 50.5 } })).status, 400);
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: {} })).status, 400);

    // 0095 pool-mode toggle: superadmin flips the brand's brain; boolean-only validation;
    // a poolMode-only patch is valid; combined with economy knobs in one PATCH works too.
    const pmOff = await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { poolMode: false } });
    assert.equal(pmOff.status, 200, "poolMode-only patch accepted");
    assert.equal((await json(pmOff)).poolMode, false);
    const pmOn = await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { poolMode: true, houseEdge: 0.7 } });
    assert.equal(pmOn.status, 200);
    const pmOnBody = await json(pmOn);
    assert.equal(pmOnBody.poolMode, true);
    assert.equal(pmOnBody.houseEdge, 0.7, "economy knob applied alongside the toggle");
    const pmRead = await json(await req(api, "GET", "/api/v1/admin/game-config", { token: "admin-1:admin" }));
    assert.equal(pmRead.poolMode, true, "pool_mode persisted and reads back");
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "root:superadmin", body: { poolMode: "yes" } })).status, 400, "non-boolean poolMode rejected");
    assert.equal((await req(api, "PATCH", "/api/v1/admin/game-config", { token: "admin-1:admin", body: { poolMode: false } })).status, 403, "day-to-day admin cannot toggle pool mode");

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "root:superadmin" }));
    assert.ok(audit.items.some((a: any) => a.action === "game.config"));
  } finally { await api.close(); }
});

test("M-Pesa config: admin reads masked; only superadmin edits; secrets write-only; audited", async () => {
  const api = await startTestApi();
  try {
    // admin can read; defaults are empty and secrets are masked to has_* flags (never returned raw)
    const cfg = await json(await req(api, "GET", "/api/v1/admin/mpesa-config", { token: "admin-1:admin" }));
    assert.equal(cfg.environment, "sandbox");
    assert.equal(cfg.shortcode, "");
    assert.equal(cfg.hasConsumerKey, false);
    assert.equal(cfg.consumerKey, undefined); // raw secret never present on the wire

    // a day-to-day admin cannot edit (superadmin only)
    assert.equal((await req(api, "PATCH", "/api/v1/admin/mpesa-config", { token: "admin-1:admin", body: { shortcode: "174379" } })).status, 403);

    // superadmin sets plain fields + a secret; response stays masked, secret reflected as has_*=true
    const upd = await req(api, "PATCH", "/api/v1/admin/mpesa-config", {
      token: "root:superadmin",
      body: { environment: "production", shortcode: "174379", consumerKey: "ck_live_abc", stkCallbackUrl: "https://x/cb" },
    });
    assert.equal(upd.status, 200);
    const u = await json(upd);
    assert.equal(u.environment, "production");
    assert.equal(u.shortcode, "174379");
    assert.equal(u.stkCallbackUrl, "https://x/cb");
    assert.equal(u.hasConsumerKey, true);
    assert.equal(u.consumerKey, undefined);

    // omitting/empty a secret keeps the existing one; bad environment + empty patch -> 400
    const keep = await json(await req(api, "PATCH", "/api/v1/admin/mpesa-config", { token: "root:superadmin", body: { consumerSecret: "" , shortcode: "600000" } }));
    assert.equal(keep.hasConsumerKey, true); // unchanged
    assert.equal(keep.shortcode, "600000");
    assert.equal((await req(api, "PATCH", "/api/v1/admin/mpesa-config", { token: "root:superadmin", body: { environment: "nope" } })).status, 400);
    assert.equal((await req(api, "PATCH", "/api/v1/admin/mpesa-config", { token: "root:superadmin", body: {} })).status, 400);

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "root:superadmin" }));
    assert.ok(audit.items.some((a: any) => a.action === "mpesa.config"));
  } finally { await api.close(); }
});

test("user role: admin promotes player<->marketer; superadmin full power; validates; no self-action; audited", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712000099", "role_target");

    // item 6: a plain admin CAN promote player -> marketer, but CANNOT mint an admin
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/role`, { token: "admin-1:admin", body: { role: "admin" } })).status, 403);
    const adminUp = await req(api, "POST", `/api/v1/admin/users/${uid}/role`, { token: "admin-1:admin", body: { role: "marketer" } });
    assert.equal(adminUp.status, 200);
    assert.equal((await json(adminUp)).role, "marketer");
    // demote back to player (superadmin) so the flow below is meaningful
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/role`, { token: "root-1:superadmin", body: { role: "player" } })).status, 200);

    // superadmin promotes player -> marketer
    const up = await req(api, "POST", `/api/v1/admin/users/${uid}/role`, { token: "root-1:superadmin", body: { role: "marketer" } });
    assert.equal(up.status, 200);
    assert.equal((await json(up)).role, "marketer");

    // invalid role -> 400; self-action -> 409
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/role`, { token: "root-1:superadmin", body: { role: "wizard" } })).status, 400);
    assert.equal((await req(api, "POST", `/api/v1/admin/users/root-1/role`, { token: "root-1:superadmin", body: { role: "admin" } })).status, 409);

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "root-1:superadmin" }));
    assert.ok(audit.items.some((a: any) => a.action === "user.role" && a.targetId === uid));
  } finally { await api.close(); }
});

test("superadmin is a protected singleton owner: cannot be created, demoted, banned, or debited", async () => {
  const api = await startTestApi();
  try {
    const owner = await register(api, "0712000077", "owner_acct");
    api.identity.adminSetRole(owner, "superadmin"); // this account is now the owner

    // (a) no one can mint a second superadmin
    const other = await register(api, "0712000078", "wannabe");
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${other}/role`, { token: "root-1:superadmin", body: { role: "superadmin" } })).status, 403);
    // (b) the owner cannot be demoted
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${owner}/role`, { token: "root-1:superadmin", body: { role: "admin" } })).status, 403);
    // (c) the owner cannot be suspended/banned
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${owner}/ban`, { token: "root-1:superadmin" })).status, 403);
    // (d) the owner's wallet cannot be adjusted
    assert.equal((await req(api, "POST", `/api/v1/admin/wallets/${owner}/adjust`, { token: "root-1:superadmin", body: { amountCents: 1000, reason: "x" } })).status, 403);
  } finally { await api.close(); }
});

test("J5 RTP monitor: target derived from house_edge, rolling windows, no alert on empty data", async () => {
  const api = await startTestApi();
  try {
    const rtp = await json(await req(api, "GET", "/api/v1/admin/rtp", { token: "admin-1:admin" }));
    assert.equal(rtp.targetRtp, 0.25);
    assert.ok(Array.isArray(rtp.windows) && rtp.windows.length === 3);
    assert.equal(rtp.windows[2].window, "all");
    assert.equal(rtp.windows[2].realisedRtp, null); // no settled positions yet
    assert.equal(rtp.alert, false);
    // player is forbidden
    const uid = await register(api, "0712220001", "rtp_player");
    assert.equal((await req(api, "GET", "/api/v1/admin/rtp", { token: uid })).status, 403);
  } finally { await api.close(); }
});

test("J5 seed rotation: superadmin-only, future-day-only, bumps version, listed + audited", async () => {
  const api = await startTestApi();
  try {
    // day-to-day admin cannot rotate
    assert.equal((await req(api, "POST", "/api/v1/admin/seeds/rotate", { token: "admin-1:admin", body: { tradeDate: "2999-01-01" } })).status, 403);
    // malformed date -> 400; past date -> 409
    assert.equal((await req(api, "POST", "/api/v1/admin/seeds/rotate", { token: "root:superadmin", body: { tradeDate: "nope" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/seeds/rotate", { token: "root:superadmin", body: { tradeDate: "2000-01-01" } })).status, 409);

    // future day rotates: version 1 then 2
    const r1 = await json(await req(api, "POST", "/api/v1/admin/seeds/rotate", { token: "root:superadmin", body: { tradeDate: "2999-01-01" } }));
    assert.equal(r1.seedVersion, 1);
    const r2 = await json(await req(api, "POST", "/api/v1/admin/seeds/rotate", { token: "root:superadmin", body: { tradeDate: "2999-01-01" } }));
    assert.equal(r2.seedVersion, 2);

    const seeds = await json(await req(api, "GET", "/api/v1/admin/seeds", { token: "admin-1:admin" }));
    assert.ok(seeds.items.some((s: any) => s.tradeDate === "2999-01-01" && s.seedVersion === 2));

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "root:superadmin" }));
    assert.ok(audit.items.some((a: any) => a.action === "game.seed_rotate" && a.targetId === "2999-01-01"));
  } finally { await api.close(); }
});

// ──────────────────────────────────────────── J6: affiliate payout queue + chat moderation ──────

test("J6 affiliate payout queue: admin lists requests and approves (audited)", async () => {
  const api = await startTestApi();
  try {
    const affId = await register(api, "0712345678", "marketer");
    const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
    const refId = await register(api, "0722333444", "referred", { referral_code: code });
    api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500); // GGR 7500 -> 20% = 1500
    await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin`, body: { date: "2026-06-10" } });
    const payout = await json(await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` }));

    // queue list, filtered to requested
    const queue = await json(await req(api, "GET", "/api/v1/admin/affiliate/payouts?status=requested", { token: "admin-1:admin" }));
    assert.ok(queue.items.some((p: any) => p.payoutId === payout.payoutId && p.amountCents === 1500 && p.username === "marketer"));

    // approve dispatches B2C (stub) and is audited
    const appr = await req(api, "POST", `/api/v1/admin/affiliate/payouts/${payout.payoutId}/approve`, { token: "admin-9:admin" });
    assert.equal(appr.status, 200);
    assert.equal((await json(appr)).approved, true);

    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "admin-9:admin" }));
    assert.ok(audit.items.some((a: any) => a.action === "affiliate.payout.approve" && a.targetId === payout.payoutId));

    // a player cannot view the queue
    const uid = await register(api, "0712220009", "pq_player");
    assert.equal((await req(api, "GET", "/api/v1/admin/affiliate/payouts", { token: uid })).status, 403);
  } finally { await api.close(); }
});

test("admin user activity: merges deposits, withdrawals and bets newest-first with kind filter + paging", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009001", "timeline");

    // Seed cash transactions (deposit + withdrawal) and two bets for this user.
    api.payRepo.seed(uid, 1_000_000);
    await api.payRepo.createDeposit(uid, 50_000, "254712009001");
    await api.payRepo.createWithdrawal(uid, 20_000, "254712009001", 5_000);
    api.gameRepo.seed(uid, 1_000_000);
    const t0 = Date.now();
    const bet1 = await api.gameRepo.openPosition({ userId: uid, stakeCents: 10_000, direction: "buy", entryRate: 100, durationS: 10, gameDayId: 2, nonce: 1, openedAtMs: t0 , configVersion: 1});
    await api.gameRepo.settlePosition({ positionId: bet1.positionId, exitRate: 130, result: "win", multiplier: 3, payoutCents: 30_000 });
    await api.gameRepo.openPosition({ userId: uid, stakeCents: 5_000, direction: "sell", entryRate: 100, durationS: 10, gameDayId: 2, nonce: 2, openedAtMs: t0 + 1 , configVersion: 1});

    // Full timeline: all four events, newest-first by createdAtMs.
    const all = await json(await req(api, "GET", `/api/v1/admin/users/${uid}/activity`, { token: "admin-1:admin" }));
    assert.equal(all.items.length, 4);
    const kinds = all.items.map((i: any) => i.kind).sort();
    assert.deepEqual(kinds, ["bet", "bet", "deposit", "withdrawal"]);
    for (let i = 1; i < all.items.length; i++) {
      assert.ok(all.items[i - 1].createdAtMs >= all.items[i].createdAtMs, "newest-first ordering");
    }
    // A settled bet exposes its position fields; cash events carry phone.
    const settledBet = all.items.find((i: any) => i.kind === "bet" && i.status === "settled");
    assert.equal(settledBet.result, "win");
    assert.equal(settledBet.payoutCents, 30_000);
    assert.equal(settledBet.amountCents, 10_000);
    const dep = all.items.find((i: any) => i.kind === "deposit");
    assert.equal(dep.phone, "254712009001");
    assert.equal(dep.amountCents, 50_000);

    // kind filter narrows to a single source.
    const betsOnly = await json(await req(api, "GET", `/api/v1/admin/users/${uid}/activity?kind=bet`, { token: "admin-1:admin" }));
    assert.equal(betsOnly.items.length, 2);
    assert.ok(betsOnly.items.every((i: any) => i.kind === "bet"));

    // Keyset pagination: limit=1 walks the whole timeline without dupes.
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url = `/api/v1/admin/users/${uid}/activity?limit=1` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page = await json(await req(api, "GET", url, { token: "admin-1:admin" }));
      assert.ok(page.items.length <= 1);
      for (const it of page.items) assert.ok(!seen.has(it.id), "no duplicate across pages"), seen.add(it.id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.size, 4);

    // Invalid kind is rejected; player tokens are forbidden.
    assert.equal((await req(api, "GET", `/api/v1/admin/users/${uid}/activity?kind=bogus`, { token: "admin-1:admin" })).status, 400);
    assert.equal((await req(api, "GET", `/api/v1/admin/users/${uid}/activity`, { token: uid })).status, 403);
  } finally { await api.close(); }
});

test("fly restart: restarts engine, skips the serving (self) machine + stopped ones, aggregates result", async () => {
  process.env.FLY_API_TOKEN = "test-fly-token";
  process.env.FLY_APP_NAMES = "invest254-engine-pm,invest254-api";
  process.env.FLY_MACHINE_ID = "self-machine"; // the API machine serving this request
  const realFetch = globalThis.fetch;
  const restarted: string[] = [];
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("api.machines.dev")) {
      if (url.endsWith("/machines")) {
        const app = url.split("/apps/")[1].split("/")[0];
        const machines = app === "invest254-api"
          ? [{ id: "self-machine", state: "started" }, { id: "api-2", state: "stopped" }]
          : [{ id: "eng-1", state: "started" }, { id: "eng-2", state: "started" }];
        return new Response(JSON.stringify(machines), { status: 200 });
      }
      if (url.endsWith("/restart")) {
        restarted.push(url.split("/machines/")[1].split("/")[0]);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const api = await startTestApi();
  try {
    // player is forbidden; admin is forbidden (superadmin-only); superadmin succeeds.
    assert.equal((await req(api, "POST", "/api/v1/admin/fly/restart", { token: "p:player" })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/fly/restart", { token: "a:admin" })).status, 403);

    const res = await req(api, "POST", "/api/v1/admin/fly/restart", { token: "owner:superadmin" });
    assert.equal(res.status, 200);
    const body = await json(res);

    assert.equal(body.ok, true);
    assert.equal(body.machinesRestarted, 2, "both engine machines restart");
    assert.ok(restarted.includes("eng-1") && restarted.includes("eng-2"));
    assert.ok(!restarted.includes("self-machine"), "must NOT restart the machine serving the request");

    const apiApp = body.apps.find((a: any) => a.app === "invest254-api");
    assert.equal(apiApp.machinesRestarted, 0);
    assert.equal(apiApp.skippedSelf, 1);
    assert.equal(apiApp.skippedStopped, 1);

    // status endpoint reflects both target apps + configured
    const st = await json(await req(api, "GET", "/api/v1/admin/fly/status", { token: "owner:superadmin" }));
    assert.equal(st.configured, true);
    assert.deepEqual(st.apps, ["invest254-engine-pm", "invest254-api"]);
  } finally {
    await api.close();
    globalThis.fetch = realFetch;
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAMES;
    delete process.env.FLY_MACHINE_ID;
  }
});

test("fly restart: surfaces a per-app error when a machine restart call fails", async () => {
  process.env.FLY_API_TOKEN = "test-fly-token";
  process.env.FLY_APP_NAMES = "invest254-engine-pm";
  delete process.env.FLY_MACHINE_ID;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("api.machines.dev")) {
      if (url.endsWith("/machines")) return new Response(JSON.stringify([{ id: "eng-1", state: "started" }]), { status: 200 });
      if (url.endsWith("/restart")) return new Response("nope", { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const api = await startTestApi();
  try {
    const body = await json(await req(api, "POST", "/api/v1/admin/fly/restart", { token: "owner:superadmin" }));
    assert.equal(body.ok, false);
    assert.equal(body.machinesRestarted, 0);
    assert.equal(body.apps[0].failed, 1);
    assert.ok(String(body.apps[0].error).includes("failed"));
  } finally {
    await api.close();
    globalThis.fetch = realFetch;
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAMES;
  }
});

test("admin transactions: unified deposits+withdrawals feed with kind filter, search and validation", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712009090", "txapi_user");
    api.payRepo.seed(uid, 500_000);
    const dep = await api.payRepo.createDeposit(uid, 100_000, "254712009090");
    await api.payRepo.attachStk(dep, "m1", "chk-tx1");
    await api.payRepo.completeDeposit("chk-tx1", 0, "ok", "RCPT-TX1", {});
    await api.payRepo.createWithdrawal(uid, 40_000, "254712009090", 1_000);

    // unified feed: both kinds present, username joined
    const all = await json(await req(api, "GET", "/api/v1/admin/transactions", { token: "adm-1:admin" }));
    assert.ok(Array.isArray(all.items) && all.items.length >= 2, "feed returns rows");
    assert.ok(all.items.some((t: any) => t.kind === "deposit"), "has a deposit");
    assert.ok(all.items.some((t: any) => t.kind === "withdrawal"), "has a withdrawal");
    assert.ok(all.items.some((t: any) => t.username === "txapi_user"), "username joined");

    // kind filter
    const deps = await json(await req(api, "GET", "/api/v1/admin/transactions?kind=deposit", { token: "adm-1:admin" }));
    assert.ok(deps.items.every((t: any) => t.kind === "deposit"), "kind=deposit filters");

    // status filter (only the completed deposit)
    const success = await json(await req(api, "GET", "/api/v1/admin/transactions?status=success", { token: "adm-1:admin" }));
    assert.ok(success.items.every((t: any) => t.status === "success"), "status filter");
    assert.ok(success.items.some((t: any) => t.mpesaReceipt === "RCPT-TX1"), "receipt surfaced");

    // search by username
    const searched = await json(await req(api, "GET", "/api/v1/admin/transactions?q=txapi", { token: "adm-1:admin" }));
    assert.ok(searched.items.length >= 1 && searched.items.every((t: any) => t.username.includes("txapi")), "q search");

    // invalid kind -> 400
    const bad = await req(api, "GET", "/api/v1/admin/transactions?kind=bogus", { token: "adm-1:admin" });
    assert.equal(bad.status, 400, "invalid kind rejected");

    // player token -> 403 (role-gated)
    const forbidden = await req(api, "GET", "/api/v1/admin/transactions", { token: uid });
    assert.equal(forbidden.status, 403, "player forbidden");
  } finally { await api.close(); }
});

test("admin users: numeric filters (minDepositsCents, minBalanceCents) narrow the list", async () => {
  const api = await startTestApi();
  try {
    const whale = await register(api, "0712009191", "api_whale");
    const lurker = await register(api, "0712009192", "api_lurker");
    // whale: 100000 balance + 100000 success deposit
    api.payRepo.seed(whale, 0);
    const d = await api.payRepo.createDeposit(whale, 100_000, "254712009191");
    await api.payRepo.attachStk(d, "m1", "chk-w"); await api.payRepo.completeDeposit("chk-w", 0, "ok", "R-W", {});
    // lurker: nothing
    api.payRepo.seed(lurker, 0);

    const all = await json(await req(api, "GET", "/api/v1/admin/users", { token: "adm-1:admin" }));
    const allNames = all.items.map((x: any) => x.username);
    assert.ok(allNames.includes("api_whale") && allNames.includes("api_lurker"), "both present unfiltered");

    const rich = await json(await req(api, "GET", "/api/v1/admin/users?minDepositsCents=1", { token: "adm-1:admin" }));
    const richNames = rich.items.map((x: any) => x.username);
    assert.ok(richNames.includes("api_whale"), "whale passes minDeposits");
    assert.ok(!richNames.includes("api_lurker"), "lurker filtered out by minDeposits");

    const bal = await json(await req(api, "GET", "/api/v1/admin/users?minBalanceCents=50000", { token: "adm-1:admin" }));
    const balNames = bal.items.map((x: any) => x.username);
    assert.ok(balNames.includes("api_whale") && !balNames.includes("api_lurker"), "minBalance narrows to whale");

    // invalid/negative values are ignored (no crash, returns list)
    const bad = await req(api, "GET", "/api/v1/admin/users?minDepositsCents=abc&minBets=-3", { token: "adm-1:admin" });
    assert.equal(bad.status, 200, "invalid numeric params ignored");
  } finally { await api.close(); }
});

async function fundOnce(api: TestApi, uid: string, phone: string, amountCents: number, tag: string) {
  const dep = await api.payRepo.createDeposit(uid, amountCents, phone);
  await api.payRepo.attachStk(dep, `m-${tag}`, `chk-${tag}`);
  await api.payRepo.completeDeposit(`chk-${tag}`, 0, "ok", `RCPT-${tag}`, {});
}

test("admin reset-balance: restores a user's real wallet to their last funded amount", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712300001", "reset_api");
    api.payRepo.seed(uid, 0);
    await fundOnce(api, uid, "254712300001", 100_000, "a");
    await new Promise((r) => setTimeout(r, 5)); // ensure a strictly-later timestamp for the last deposit
    await fundOnce(api, uid, "254712300001", 40_000, "b"); // last funded = 40k
    api.payRepo.adminApplyAdjustment(uid, 500_000); // corrupt the balance

    // requires a reason
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/reset-balance`, { token: "adm-1:admin", body: {} })).status, 400);

    const res = await json(await req(api, "POST", `/api/v1/admin/users/${uid}/reset-balance`, { token: "adm-1:admin", body: { reason: "settlement bug" } }));
    assert.equal(res.lastFundedCents, 40_000);
    assert.equal(res.newBalanceCents, 40_000);

    const detail = await json(await req(api, "GET", `/api/v1/admin/users/${uid}`, { token: "adm-1:admin" }));
    assert.equal(detail.realBalanceCents, 40_000);
    assert.equal(detail.lastFundedCents, 40_000);

    // a player cannot reset balances
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${uid}/reset-balance`, { token: uid, body: { reason: "x" } })).status, 403);
  } finally { await api.close(); }
});

test("admin bulk: mass suspend / notify / reset-balance with per-user partial results", async () => {
  const api = await startTestApi();
  try {
    const a = await register(api, "0712310001", "bulk_a");
    const b = await register(api, "0712310002", "bulk_b");
    for (const [uid, phone] of [[a, "254712310001"], [b, "254712310002"]] as [string, string][]) {
      api.payRepo.seed(uid, 0);
      await fundOnce(api, uid, phone, 30_000, uid.slice(0, 6));
      api.payRepo.adminApplyAdjustment(uid, 200_000); // corrupt
    }

    // bulk suspend both
    const susp = await json(await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "suspend", userIds: [a, b], reason: "audit" } }));
    assert.equal(susp.okCount, 2);
    assert.equal(susp.failCount, 0);
    for (const uid of [a, b]) {
      const d = await json(await req(api, "GET", `/api/v1/admin/users/${uid}`, { token: "adm-1:admin" }));
      assert.equal(d.status, "suspended");
    }

    // bulk notify both
    const notify = await json(await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "notify", userIds: [a, b], title: "Maintenance", level: "warning" } }));
    assert.equal(notify.okCount, 2);
    for (const uid of [a, b]) {
      const list = await json(await req(api, "GET", `/api/v1/admin/users/${uid}/notifications`, { token: "adm-1:admin" }));
      assert.ok(list.items.some((n: any) => n.title === "Maintenance"));
    }

    // bulk reset-balance both -> back to 30k
    const reset = await json(await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "reset-balance", userIds: [a, b], reason: "recover" } }));
    assert.equal(reset.okCount, 2);
    for (const uid of [a, b]) {
      const d = await json(await req(api, "GET", `/api/v1/admin/users/${uid}`, { token: "adm-1:admin" }));
      assert.equal(d.realBalanceCents, 30_000);
    }

    // partial failure: self-action is rejected for that target only
    const mixed = await json(await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "suspend", userIds: [a, "adm-1"], reason: "audit" } }));
    assert.equal(mixed.okCount, 1);
    assert.equal(mixed.failCount, 1);
    assert.ok(mixed.results.find((r: any) => r.userId === "adm-1" && !r.ok));

    // validation
    assert.equal((await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "suspend", userIds: [] } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "bogus", userIds: [a] } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/admin/users/bulk", { token: "adm-1:admin", body: { action: "reset-balance", userIds: [a] } })).status, 400); // reason required

    // player forbidden
    assert.equal((await req(api, "POST", "/api/v1/admin/users/bulk", { token: a, body: { action: "suspend", userIds: [b], reason: "x" } })).status, 403);
  } finally { await api.close(); }
});
