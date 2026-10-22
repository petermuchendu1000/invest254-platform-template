import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, makeInMemoryReferralRepo } from "./testutil.js";
import { MONEY_RANGES, resolveMoneyRange, type MoneyRangeKey } from "./app.affiliate.js";
import { makePgReferralRepo, type MarketerMoneyStatement, type MoneyRangeBounds } from "./referral.pg.js";

/**
 * `GET /affiliate/money` — the marketer money table's range filter.
 *
 * Covers: every range's resolved bounds, the default when `?range=` is absent, the refusal of an
 * unrecognised value, the identity gate, and the BUGLOG #23 property that a windowed TOTAL is a real
 * SQL aggregate and never the sum of the limit-capped page beside it.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function req(api: TestApi, method: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${api.baseUrl}${path}`, { method, headers });
}

async function register(api: TestApi, phone: string, username: string): Promise<string> {
  const res = await fetch(`${api.baseUrl}/api/v1/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, username, password: "Password1" }),
  });
  assert.equal(res.status, 201, `register ${username} -> ${res.status}`);
  return (await json(res)).userId as string;
}

/** An empty statement, so a fake only has to say what it is being tested for. */
const EMPTY: MarketerMoneyStatement = {
  window: {
    earnedCents: 0, earnedCount: 0, otherCommissionCents: 0,
    expensesCents: 0, expensesCount: 0,
    advancesApprovedCents: 0, advancesPendingCents: 0, advancesCount: 0,
    payoutsPaidCents: 0, payoutsPendingCents: 0,
  },
  lifetime: { earnedCents: 0, expensesCents: 0, paidCents: 0, heldCents: 0, availableCents: 0 },
  commissions: [], expenses: [], advances: [],
};

/** The in-memory referral repo plus the ranged-money capability, recording every call. */
function moneyRepoFake(statement: MarketerMoneyStatement = EMPTY) {
  const calls: Array<{ userId: string; range: MoneyRangeBounds; limit: number }> = [];
  const repo = {
    ...makeInMemoryReferralRepo(),
    async marketerMoney(userId: string, range: MoneyRangeBounds, limit: number) {
      calls.push({ userId, range, limit });
      return statement;
    },
  };
  return { repo, calls };
}

// ── 1. Every range's bounds ─────────────────────────────────────────────────────────────────────

test("money range: each range resolves to the inclusive EAT [from, to] bounds of the admin report convention", () => {
  // 2026-03-14T22:30:00Z is 2026-03-15 01:30 in Africa/Nairobi (UTC+3) — deliberately an instant
  // whose UTC date and EAT date differ, so a UTC-bucketed implementation would fail every case.
  const now = Date.parse("2026-03-14T22:30:00Z");

  assert.deepEqual(resolveMoneyRange("today", now), { from: "2026-03-15", to: "2026-03-15" },
    "today is one EAT day, closed at both ends");
  assert.deepEqual(resolveMoneyRange("yesterday", now), { from: "2026-03-14", to: "2026-03-14" },
    "yesterday is the single EAT day before today, not a trailing 48h");
  // Trailing N days ENDING TODAY, inclusive — the same shape as periodRange in mt5history.ts.
  assert.deepEqual(resolveMoneyRange("7d", now), { from: "2026-03-09", to: "2026-03-15" });
  assert.deepEqual(resolveMoneyRange("30d", now), { from: "2026-02-14", to: "2026-03-15" });
  assert.deepEqual(resolveMoneyRange("90d", now), { from: "2025-12-16", to: "2026-03-15" });
  assert.deepEqual(resolveMoneyRange("180d", now), { from: "2025-09-17", to: "2026-03-15" });
  // All time is UNBOUNDED on both sides, which is how the admin report spells "no bound" (null).
  assert.deepEqual(resolveMoneyRange("all", now), { from: null, to: null });

  // Window lengths are exactly N EAT days, inclusive of both ends.
  const days = (b: { from: string | null; to: string | null }) =>
    (Date.parse(`${b.to}T00:00:00Z`) - Date.parse(`${b.from}T00:00:00Z`)) / 86_400_000 + 1;
  assert.equal(days(resolveMoneyRange("today", now)), 1);
  assert.equal(days(resolveMoneyRange("yesterday", now)), 1);
  assert.equal(days(resolveMoneyRange("7d", now)), 7);
  assert.equal(days(resolveMoneyRange("30d", now)), 30);
  assert.equal(days(resolveMoneyRange("90d", now)), 90);
  assert.equal(days(resolveMoneyRange("180d", now)), 180);

  // Bounds are always ordered, which is the invariant the report parser enforces (from <= to).
  for (const key of MONEY_RANGES) {
    const b = resolveMoneyRange(key, now);
    if (b.from !== null && b.to !== null) assert.ok(b.from <= b.to, `${key}: from must be <= to`);
  }
});

test("money range: the EAT day boundary is honoured, not the UTC one", () => {
  // 21:05 UTC on the 14th is already 00:05 EAT on the 15th: "today" must be the 15th.
  assert.deepEqual(resolveMoneyRange("today", Date.parse("2026-03-14T21:05:00Z")),
    { from: "2026-03-15", to: "2026-03-15" });
  // 20:55 UTC on the 14th is still 23:55 EAT on the 14th.
  assert.deepEqual(resolveMoneyRange("today", Date.parse("2026-03-14T20:55:00Z")),
    { from: "2026-03-14", to: "2026-03-14" });
  // Month and year boundaries cross correctly (date arithmetic, not 86400000-ms subtraction).
  assert.deepEqual(resolveMoneyRange("yesterday", Date.parse("2026-01-01T06:00:00Z")),
    { from: "2025-12-31", to: "2025-12-31" });
  assert.deepEqual(resolveMoneyRange("7d", Date.parse("2026-03-02T06:00:00Z")),
    { from: "2026-02-24", to: "2026-03-02" }, "February 2026 has 28 days");
});

// ── 2/3. The route: default, rejection, gate, echo ──────────────────────────────────────────────

test("GET /affiliate/money: defaults to today, echoes the resolved window, and refuses an unknown range", async () => {
  const { repo, calls } = moneyRepoFake();
  const api = await startTestApi({ depsOverrides: { referral: repo } });
  try {
    const uid = await register(api, "0712700001", "moneymkt");
    const mk = `${uid}:marketer`;

    // Default: no ?range= at all -> today.
    const res = await req(api, "GET", "/api/v1/affiliate/money", mk);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.range, "today", "absent range defaults to today");
    const today = resolveMoneyRange("today", Date.now());
    assert.equal(body.from, today.from);
    assert.equal(body.to, today.to);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.userId, uid, "the store is keyed by the token subject (a profiles.id)");
    assert.deepEqual(calls[0]!.range, today);

    // An empty ?range= is the same as absent (a cleared control, not a bad value).
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?range=", mk))).range, "today");

    // Every documented range is accepted and echoed, and the bounds reaching the store match.
    for (const key of MONEY_RANGES) {
      const r = await req(api, "GET", `/api/v1/affiliate/money?range=${key}`, mk);
      assert.equal(r.status, 200, `${key} -> ${r.status}`);
      const b = await json(r);
      assert.equal(b.range, key);
      assert.deepEqual({ from: b.from, to: b.to }, calls.at(-1)!.range, `${key}: echoed bounds == bounds queried`);
    }
    // Case-insensitive, like the leaderboard's `period`.
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?range=ALL", mk))).range, "all");

    // A value outside the closed enum is REFUSED (400), never silently read as another window:
    // showing one period's money under another period's label is the failure this guards.
    const callsBefore = calls.length;
    for (const bad of ["week", "month", "lifetime", "1d", "7D%20", "'; drop table profiles; --", "2026-03-15"]) {
      const r = await req(api, "GET", `/api/v1/affiliate/money?range=${encodeURIComponent(bad)}`, mk);
      assert.equal(r.status, 400, `range=${bad} -> ${r.status}`);
      assert.equal((await json(r)).error.code, "INVALID_RANGE");
    }
    assert.equal(calls.length, callsBefore, "a refused range never reaches the store");

    // `limit` is clamped, and the resolved limit is echoed so the client knows the page is capped.
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?limit=5000", mk))).limit, 200);
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?limit=0", mk))).limit, 50);
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?limit=abc", mk))).limit, 50);
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/money?limit=7", mk))).limit, 7);
  } finally { await api.close(); }
});

test("GET /affiliate/money: gated on the AFFILIATE marketer (profiles.id), not a player and not anonymous", async () => {
  const { repo } = moneyRepoFake();
  const api = await startTestApi({ depsOverrides: { referral: repo } });
  try {
    const uid = await register(api, "0712700002", "moneyplayer");
    // No token at all.
    assert.equal((await req(api, "GET", "/api/v1/affiliate/money")).status, 401);
    // A player token: the route is `auth, site, marketer` — exactly role='marketer'.
    assert.equal((await req(api, "GET", "/api/v1/affiliate/money", uid)).status, 403);
    // The marketer token (subject = the profiles.id) passes.
    assert.equal((await req(api, "GET", "/api/v1/affiliate/money", `${uid}:marketer`)).status, 200);
  } finally { await api.close(); }
});

test("GET /affiliate/money: a store without the ranged capability refuses with 503, never a 500", async () => {
  // The default in-memory ReferralRepo has no marketerMoney().
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712700003", "moneynocap");
    const r = await req(api, "GET", "/api/v1/affiliate/money", `${uid}:marketer`);
    assert.equal(r.status, 503);
  } finally { await api.close(); }
});

// ── 4. BUGLOG #23: a windowed total is a real total, not a page sum ─────────────────────────────

/**
 * A stub `Query` standing in for Postgres. It dispatches on the SQL it is handed, records every
 * (sql, params) pair, and answers the TOTALS query with figures that deliberately disagree with the
 * rows it answers the LIST queries with. A repository that derived a total from its page would
 * return the page's sum and fail.
 */
function stubQuery(opts: { totals: Record<string, number>; pageRows: number; pageCents: number }) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    seen.push({ sql, params });
    if (sql.includes("as earned_n")) return { rows: [opts.totals] };
    if (sql.includes("fn_commission_balance")) {
      return { rows: [{ earned_cents: 850_00, held_cents: 0, paid_cents: 562_50, available_cents: 0, expenses_cents: 440_00 }] };
    }
    const at = new Date("2026-03-15T09:00:00Z").toISOString();
    if (sql.includes("from public.deposit_commissions")) {
      return { rows: Array.from({ length: opts.pageRows }, (_, i) => ({
        id: i + 1, deposit_tx_id: `tx-${i}`, referred_user: `u-${i}`, referred_username: `p${i}`,
        position: 1, beneficiary_role: "marketer", rate: 0.25,
        deposit_amount: opts.pageCents * 4, commission_amount: opts.pageCents, status: "accrued", created_at: at,
      })) };
    }
    if (sql.includes("from public.marketer_expenses")) {
      return { rows: Array.from({ length: opts.pageRows }, (_, i) => ({
        id: `e-${i}`, category: "data_bundles", amount_cents: opts.pageCents, note: null, created_at: at, created_by: null,
      })) };
    }
    if (sql.includes("from public.marketer_advance_requests")) {
      return { rows: Array.from({ length: opts.pageRows }, (_, i) => ({
        id: `a-${i}`, amount_cents: opts.pageCents, reason: null, status: "approved",
        decision_note: null, decided_at: at, expense_id: `e-${i}`, created_at: at,
      })) };
    }
    return { rows: [] };
  };
  return { query, seen };
}

test("marketerMoney: every windowed total is a full SQL aggregate, never the sum of the capped page (BUGLOG #23)", async () => {
  // The recorded failure, reproduced in miniature: the page shows 2 rows worth 10,000 while the true
  // range total is 59,000. A total taken from the page would under-report by 49,000.
  const { query, seen } = stubQuery({
    totals: {
      earned: 59_000, earned_n: 150, other_comm: 1_200,
      expenses: 59_000, expenses_n: 150,
      adv_approved: 30_000, adv_pending: 12_000, adv_n: 9,
      payouts_paid: 56_250, payouts_held: 7_500,
    },
    pageRows: 2, pageCents: 5_000,
  });
  const repo = makePgReferralRepo(query);
  const bounds = { from: "2026-03-09", to: "2026-03-15" };
  const st = await repo.marketerMoney("11111111-1111-1111-1111-111111111111", bounds, 2);

  // The page really is capped and really does sum to less than the total — otherwise this test
  // would pass for the wrong reason.
  assert.equal(st.commissions.length, 2);
  assert.equal(st.commissions.reduce((s, c) => s + c.commissionCents, 0), 10_000);
  assert.equal(st.expenses.length, 2);
  assert.equal(st.expenses.reduce((s, e) => s + e.amountCents, 0), 10_000);
  assert.equal(st.advances.length, 2);

  // ...and every total is the aggregate, not the page.
  assert.equal(st.window.earnedCents, 59_000, "earned total is the SQL sum over the whole range");
  assert.equal(st.window.earnedCount, 150, "the count is a SQL count(*), not items.length");
  assert.equal(st.window.expensesCents, 59_000);
  assert.equal(st.window.expensesCount, 150);
  assert.equal(st.window.otherCommissionCents, 1_200);
  assert.equal(st.window.advancesApprovedCents, 30_000);
  assert.equal(st.window.advancesPendingCents, 12_000);
  assert.equal(st.window.advancesCount, 9);
  assert.equal(st.window.payoutsPaidCents, 56_250);
  assert.equal(st.window.payoutsPendingCents, 7_500);

  // The lifetime block is the un-ranged fn_commission_balance ladder plus the full expense sum,
  // and it floors at 0 in SQL — the hero's figure, not a windowed one.
  assert.deepEqual(st.lifetime, {
    earnedCents: 85_000, expensesCents: 44_000, paidCents: 56_250, heldCents: 0, availableCents: 0,
  });

  // The totals query carries NO limit at all; the list queries are the only limited ones.
  const totalsSql = seen.find((s) => s.sql.includes("as earned_n"))!.sql;
  assert.ok(!/\blimit\b/i.test(totalsSql), "a total must never be computed under a LIMIT");
  const listSqls = seen.filter((s) => /order by/i.test(s.sql)).map((s) => s.sql);
  assert.equal(listSqls.length, 3, "three display pages: commissions, expenses, advances");
  for (const sql of listSqls) assert.ok(/limit \$4/.test(sql), "each page is limit-capped by a bound param");

  // The lifetime read goes through the authoritative RPCs, un-ranged (one param: the user).
  const lifeCall = seen.find((s) => s.sql.includes("fn_commission_balance"))!;
  assert.deepEqual(lifeCall.params, ["11111111-1111-1111-1111-111111111111"]);
  assert.ok(lifeCall.sql.includes("fn_marketer_expenses_total"), "the FULL expense sum RPC (0121)");
  assert.ok(!lifeCall.sql.includes("Africa/Nairobi"), "the lifetime ladder is never range-filtered");
});

test("marketerMoney: bounds are bound parameters in EAT, on the right timestamp column per table", async () => {
  const { query, seen } = stubQuery({
    totals: { earned: 0, earned_n: 0, other_comm: 0, expenses: 0, expenses_n: 0, adv_approved: 0, adv_pending: 0, adv_n: 0, payouts_paid: 0, payouts_held: 0 },
    pageRows: 0, pageCents: 0,
  });
  const repo = makePgReferralRepo(query);
  const user = "22222222-2222-2222-2222-222222222222";
  await repo.marketerMoney(user, { from: "2026-03-09", to: "2026-03-15" }, 25);

  const ranged = seen.filter((s) => s.sql.includes("Africa/Nairobi"));
  assert.ok(ranged.length >= 4, "totals + three pages are all range-filtered");
  for (const { sql, params } of ranged) {
    // Nothing client-supplied is interpolated: the dates are $2/$3, cast with ::date in SQL.
    assert.equal(params[0], user);
    assert.equal(params[1], "2026-03-09");
    assert.equal(params[2], "2026-03-15");
    assert.ok(!sql.includes("2026-03-09"), "a date must never appear in the SQL text");
    // The admin report convention, verbatim: inclusive on BOTH ends, null meaning unbounded.
    assert.ok(sql.includes("$2::date is null or"), "null `from` means unbounded, not 1970");
    assert.ok(sql.includes("$3::date is null or"), "null `to` means unbounded, not now()");
    assert.ok(sql.includes(">= $2::date") && sql.includes("<= $3::date"),
      "bounds are [from, to] — inclusive, not half-open");
  }

  const totalsSql = seen.find((s) => s.sql.includes("as earned_n"))!.sql;
  // The commission row's OWN timestamp (written at deposit settlement), not the deposit tx's.
  assert.ok(totalsSql.includes("(dc.created_at at time zone 'Africa/Nairobi')::date"));
  assert.ok(!/transactions/.test(totalsSql), "the deposit transaction's timestamp is not the axis");
  assert.ok(totalsSql.includes("(e.created_at at time zone 'Africa/Nairobi')::date"));
  assert.ok(totalsSql.includes("(a.created_at at time zone 'Africa/Nairobi')::date"));
  // Payouts: money that LEFT is ranged on paid_at; money still held on requested_at.
  assert.ok(totalsSql.includes("(p.paid_at at time zone 'Africa/Nairobi')::date"));
  assert.ok(totalsSql.includes("(p.requested_at at time zone 'Africa/Nairobi')::date"));

  // All time: both bounds null, and the same SQL serves it (the `is null or` branches).
  const before = seen.length;
  await repo.marketerMoney(user, { from: null, to: null }, 25);
  for (const { params } of seen.slice(before).filter((s) => s.sql.includes("Africa/Nairobi"))) {
    assert.equal(params[1], null);
    assert.equal(params[2], null);
  }
});

test("marketerMoney: the windowed earned predicate is the same one fn_commission_balance earns on", async () => {
  const { query, seen } = stubQuery({
    totals: { earned: 0, earned_n: 0, other_comm: 0, expenses: 0, expenses_n: 0, adv_approved: 0, adv_pending: 0, adv_n: 0, payouts_paid: 0, payouts_held: 0 },
    pageRows: 0, pageCents: 0,
  });
  const repo = makePgReferralRepo(query);
  await repo.marketerMoney("33333333-3333-3333-3333-333333333333", { from: "2026-03-15", to: "2026-03-15" }, 10);
  const totalsSql = seen.find((s) => s.sql.includes("as earned_n"))!.sql;
  // fn_commission_balance (0105): beneficiary_role='marketer' and status='accrued'. The windowed
  // figure uses the SAME predicate so it is a true subset of the lifetime earned, and the leftover
  // (a promoted player's instant 5%) is reported separately instead of being folded in or dropped.
  assert.ok(totalsSql.includes("dc.beneficiary_role = 'marketer' and dc.status = 'accrued'"));
  assert.ok(totalsSql.includes("not (dc.beneficiary_role = 'marketer' and dc.status = 'accrued')"));
  // Every read is keyed on the affiliate's profiles.id columns — never a marketers.id column.
  assert.ok(totalsSql.includes("dc.beneficiary_user = $1"));
  assert.ok(totalsSql.includes("e.marketer_user_id = $1"));
  assert.ok(totalsSql.includes("a.marketer_user_id = $1"));
  assert.ok(totalsSql.includes("p.beneficiary_user = $1"));
});

// A compile-time check that the enum the route accepts is exactly the UI's seven windows.
const _exhaustive: Record<MoneyRangeKey, true> = {
  today: true, yesterday: true, "7d": true, "30d": true, "90d": true, "180d": true, all: true,
};
void _exhaustive;
