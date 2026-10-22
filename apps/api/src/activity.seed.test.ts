import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makePgBrandActivity,
  leaderboardWindowSql,
  type ActivityQuerier,
  type LeaderboardPeriod,
} from "./activity.pg.js";
import { startTestApi, SITE_A, TEST_BRANDS, type TestApi } from "./testutil.js";
import type { Brand } from "./app.js";

/**
 * The SEEDED sources (activity_seed 0193, leaderboard_seed 0194) and the three rules that decide
 * what reaches a player: WHICH BRANDS may see them at all, that they arrive OVER TIME rather than
 * all at once, and that they can never crowd a real event off the screen.
 *
 * None of this can be proven against the database here — nothing but Postgres parses these strings
 * — so the store is driven by a recording stub and the assertions are of two kinds: the SQL asked
 * for (which table, which predicate, which aggregate), and the merge done in TypeScript once it
 * comes back. The one thing a stub cannot catch is a SQL syntax error, which is why the warning on
 * the UNION arms in activity.pg.ts says what it says.
 */

interface Recorded { sql: string; params: unknown[] }

/** A querier that records every statement and answers from canned rows, matched on the table name. */
function stubQuerier(rowsFor: (sql: string) => Record<string, unknown>[]): ActivityQuerier & { seen: Recorded[] } {
  const seen: Recorded[] = [];
  return {
    seen,
    async query(sql: string, params?: unknown[]) {
      seen.push({ sql, params: params ?? [] });
      return { rows: rowsFor(sql) };
    },
  };
}

const hitsActivitySeed = (r: Recorded[]) => r.filter((x) => x.sql.includes("activity_seed"));
const hitsLeaderboardSeed = (r: Recorded[]) => r.filter((x) => x.sql.includes("leaderboard_seed"));

// ---------------------------------------------------------------------------------------------
// JOB 1 — the gate
// ---------------------------------------------------------------------------------------------

test("feed: a gated brand gets its real rows and not one seed row — and not even the query", async () => {
  const q = stubQuerier((sql) =>
    sql.includes("activity_seed")
      ? [{ kind: "deposit", name: "Seeded Sam", amount_cents: 999_00, ago_seconds: 1 }]
      : [{ kind: "deposit", username: "wanjiku_254", amount_cents: 500_00, ago_seconds: 30 }],
  );
  const store = makePgBrandActivity(q);

  const gated = await store.recent(SITE_A, 25, { seededAllowed: false });
  assert.deepEqual(gated, [{ kind: "deposit", name: "Wanjiku", amountCents: 500_00, agoSeconds: 30 }]);
  // Server-side, and cheap: the gated brand does not pay for a round trip it must discard.
  assert.equal(hitsActivitySeed(q.seen).length, 0, "a gated brand must not even read the seed table");

  const allowed = await store.recent(SITE_A, 25, { seededAllowed: true });
  assert.equal(allowed.length, 2);
  assert.equal(allowed.filter((x) => x.seeded === true).length, 1);
});

test("feed: the default is unchanged behaviour — omitting the gate still merges seeds", async () => {
  // Every pre-existing caller passes no options, and must behave exactly as it did.
  const q = stubQuerier((sql) =>
    sql.includes("activity_seed") ? [{ kind: "win", name: "Seeded Sam", amount_cents: 10, ago_seconds: 2 }] : [],
  );
  const out = await makePgBrandActivity(q).recent(SITE_A, 25);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.seeded, true);
});

// ---------------------------------------------------------------------------------------------
// JOB 2 — a static table made live, and real rows that cannot be buried
// ---------------------------------------------------------------------------------------------

test("feed: the seed read is bounded by now(), which is what lets a script post-date rows", () => {
  // Without this the newest 40 seed rows are the newest 40 forever and every row reads "7d ago" a
  // week later. The predicate is the whole mechanism, so it is asserted on the SQL itself.
  const q = stubQuerier(() => []);
  return makePgBrandActivity(q).recent(SITE_A, 25, { seededAllowed: true }).then(() => {
    const seed = hitsActivitySeed(q.seen)[0];
    assert.ok(seed, "the seed table is read");
    assert.match(seed!.sql, /created_at <= now\(\)/);
    assert.match(seed!.sql, /site_id = \$1/, "and still site-scoped: one brand can never read another's");
  });
});

test("feed: real rows can never be crowded out, however many newer seed rows there are", async () => {
  // The first case that made a merge rule necessary: thousands of seeded rows minutes apart against
  // a small cap. Sorting the union by recency and truncating would bury every real event.
  const real = Array.from({ length: 3 }, (_, i) => ({
    kind: "deposit", username: `player${i}`, amount_cents: 100, ago_seconds: 10_000 + i,
  }));
  const seeded = Array.from({ length: 50 }, (_, i) => ({
    kind: "win", name: `Seed${i}`, amount_cents: 100, ago_seconds: i, // all far newer than any real row
  }));
  const q = stubQuerier((sql) => (sql.includes("activity_seed") ? seeded : real));

  const out = await makePgBrandActivity(q).recent(SITE_A, 8, { seededAllowed: true });
  assert.equal(out.length, 8);
  // The floor is ceil(8 * 0.25) = 2, and these real rows are the OLDEST rows in play, so they win
  // nothing on merit — the floor is the only reason any of them is on screen. That is the point.
  assert.ok(out.filter((x) => x.seeded !== true).length >= 2, "real rows keep their floor");
  const ages = out.map((x) => x.agoSeconds);
  assert.deepEqual(ages, [...ages].sort((a, b) => a - b), "what is shown is honestly newest-first");
});

test("feed: a brand with more real rows than the cap still shows seeded rows, when its own are stale", async () => {
  /**
   * The mirror failure, and the one that actually shipped. "Real rows take every slot they can
   * fill" made the whole feature inert on the brand it was built for: cpfmarket has more real
   * events in its history than the cap, so all 40 slots went to real rows — the newest of them 29
   * HOURS old, several a fortnight old — and 3000 seeded rows were invisible. Measured on the live
   * API as `seeded=0, real=40`.
   *
   * A fortnight-old feed above a deposit button is the dead-product look the seed exists to fix, so
   * past the floor the slots are contested on recency and recent seeded rows win them.
   */
  const real = Array.from({ length: 40 }, (_, i) => ({
    kind: "win", username: `p${i}`, amount_cents: 1, ago_seconds: 104_400 + i * 3600, // 29h and older
  }));
  const seeded = Array.from({ length: 40 }, (_, i) => ({
    kind: "deposit", name: `s${i}`, amount_cents: 1, ago_seconds: 60 + i * 60, // minutes old
  }));
  const q = stubQuerier((sql) => (sql.includes("activity_seed") ? seeded : real));

  const out = await makePgBrandActivity(q).recent(SITE_A, 40, { seededAllowed: true });
  assert.equal(out.length, 40);
  const realShown = out.filter((x) => x.seeded !== true).length;
  const seedShown = out.filter((x) => x.seeded === true).length;
  assert.equal(realShown, 10, "exactly the floor: ceil(40 * 0.25)");
  assert.equal(seedShown, 30, "and the contested slots went to the rows that are actually recent");
  assert.ok(out[0]!.seeded === true, "the top of the feed is the newest thing in it");
});

test("feed: genuinely recent real activity beats seeded rows outright, no reservation needed", async () => {
  // The case that proves the floor is a floor and not a cap: when a brand's own events are the
  // newest, they take the whole feed on merit and seeded rows get nothing.
  const real = Array.from({ length: 40 }, (_, i) => ({
    kind: "deposit", username: `p${i}`, amount_cents: 1, ago_seconds: i, // seconds old
  }));
  const seeded = Array.from({ length: 40 }, (_, i) => ({
    kind: "deposit", name: `s${i}`, amount_cents: 1, ago_seconds: 90_000 + i,
  }));
  const q = stubQuerier((sql) => (sql.includes("activity_seed") ? seeded : real));

  const out = await makePgBrandActivity(q).recent(SITE_A, 40, { seededAllowed: true });
  assert.equal(out.filter((x) => x.seeded !== true).length, 40, "a live brand's feed is all its own");
});

test("the four chips mean exactly what they always meant on positions.settled_at", () => {
  // WINDOW_AT became a template so one chip can window two sources. These are the four predicates
  // the board shipped with, character for character: the refactor must not have moved a boundary.
  const was: Record<LeaderboardPeriod, string> = {
    today: "o.settled_at >= date_trunc('day', now())",
    yesterday: "o.settled_at >= date_trunc('day', now()) - interval '1 day' and o.settled_at < date_trunc('day', now())",
    week: "o.settled_at >= date_trunc('week', now())",
    month: "o.settled_at >= date_trunc('month', now())",
  };
  for (const [p, sql] of Object.entries(was)) {
    assert.equal(leaderboardWindowSql(p as LeaderboardPeriod, "o.settled_at"), sql, p);
  }
  // And the same chip over the seed table's own timestamp, so a seeded standing moves between
  // Today and This Month exactly as a real one does.
  assert.equal(leaderboardWindowSql("week", "created_at"), "created_at >= date_trunc('week', now())");
  // An unknown chip falls back to today rather than producing no predicate at all (which would
  // silently widen the board to all time).
  assert.equal(leaderboardWindowSql("nonsense" as LeaderboardPeriod, "created_at"), leaderboardWindowSql("today", "created_at"));
});

// ---------------------------------------------------------------------------------------------
// JOB 3 — the board: total winnings, a seeded source, and the metric axis
// ---------------------------------------------------------------------------------------------

test("board: winnings is sum(payout) over WINNING positions, not sum(pnl)", async () => {
  const q = stubQuerier(() => []);
  await makePgBrandActivity(q).leaderboard(SITE_A, "today", 10, { metric: "winnings", seededAllowed: false });
  const sql = q.seen[0]!.sql;
  // payout is the gross amount credited back; pnl is payout - stake, i.e. the net. "Winnings" is
  // the gross one, and only on the rows settlement called a win.
  assert.match(sql, /sum\(o\.payout\) filter \(where o\.result = 'win'\)/);
  assert.doesNotMatch(sql, /sum\(o\.pnl\)/);
  // The exclusions the board has always had stay put.
  assert.match(sql, /coalesce\(o\.demo, false\) = false and coalesce\(o\.practice, false\) = false/);
  assert.match(sql, /o\.status = 'settled'/);
});

test("board: metric=profit is the old net ranking, unchanged", async () => {
  const q = stubQuerier(() => []);
  await makePgBrandActivity(q).leaderboard(SITE_A, "month", 10, { metric: "profit", seededAllowed: true });
  const sql = q.seen[0]!.sql;
  assert.match(sql, /sum\(o\.pnl\)::bigint as amount_cents/);
  assert.match(sql, /having sum\(o\.pnl\) > 0/);
  assert.match(sql, /order by sum\(o\.pnl\) desc/);
  assert.match(sql, /o\.settled_at >= date_trunc\('month', now\(\)\)/);
  // There is no net number in leaderboard_seed, so a profit board is never seeded.
  assert.equal(hitsLeaderboardSeed(q.seen).length, 0);
});

test("board: an unknown metric is read as winnings rather than reaching the SQL", async () => {
  const q = stubQuerier(() => []);
  // Belt and braces behind the route's own narrowing: whatever a caller passes, the interpolated
  // fragment is one of this module's literals.
  await makePgBrandActivity(q).leaderboard(SITE_A, "today", 10, { metric: "' or 1=1 --" as never });
  assert.match(q.seen[0]!.sql, /sum\(o\.payout\) filter/);
  assert.doesNotMatch(q.seen[0]!.sql, /1=1/);
});

test("board: the seeded source is aggregated per name inside the window, shown verbatim", async () => {
  const q = stubQuerier((sql) =>
    sql.includes("leaderboard_seed")
      ? [{ name: "wanjiku_254", trades: 7, amount_cents: 90_000 }]
      : [],
  );
  const out = await makePgBrandActivity(q).leaderboard(SITE_A, "week", 10, { seededAllowed: true });
  const seed = hitsLeaderboardSeed(q.seen)[0]!;
  assert.match(seed.sql, /group by name/);
  assert.match(seed.sql, /sum\(winnings_cents\)/);
  assert.match(seed.sql, /sum\(trades\)/);
  assert.match(seed.sql, /created_at >= date_trunc\('week', now\(\)\)/);
  assert.match(seed.sql, /created_at <= now\(\)/);
  // Verbatim, NOT through publicName: there is no account behind a seeded name to protect, so
  // shrinking it would only mangle a display name on purpose. publicName would give "Wanjiku".
  assert.deepEqual(out, [{ rank: 1, name: "wanjiku_254", trades: 7, profitCents: 90_000, seeded: true }]);
});

test("board: a gated brand's board is real rows only", async () => {
  const q = stubQuerier((sql) =>
    sql.includes("leaderboard_seed")
      ? [{ name: "Seeded Sam", trades: 500, amount_cents: 9_999_999 }]
      : [{ username: "njeri-k", trades: 3, amount_cents: 1_200 }],
  );
  const out = await makePgBrandActivity(q).leaderboard(SITE_A, "today", 10, { seededAllowed: false });
  assert.deepEqual(out, [{ rank: 1, name: "Njeri", trades: 3, profitCents: 1_200 }]);
  assert.equal(hitsLeaderboardSeed(q.seen).length, 0);
});

test("board: a real trader is never ranked off the board by bigger seeded numbers", async () => {
  const real = [{ username: "amina", trades: 2, amount_cents: 500 }];
  const seeded = Array.from({ length: 20 }, (_, i) => ({ name: `Seed${i}`, trades: 10, amount_cents: 1_000_000 - i }));
  const q = stubQuerier((sql) => (sql.includes("leaderboard_seed") ? seeded : real));

  const out = await makePgBrandActivity(q).leaderboard(SITE_A, "today", 3, { seededAllowed: true });
  assert.equal(out.length, 3);
  assert.equal(out.filter((x) => x.seeded !== true).length, 1, "the one real trader keeps a place");
  // The rows that are shown are still in descending order of the number printed on them, and the
  // board is renumbered 1..n after the merge rather than carrying either source's own position.
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3]);
  const amounts = out.map((x) => x.profitCents);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
  assert.equal(out[2]!.name, "Amina", "and the real row sits where its amount puts it, not above it");
});

// ---------------------------------------------------------------------------------------------
// The route: the gate is decided from the BRAND, server-side, with no extra DB read
// ---------------------------------------------------------------------------------------------

/** A brand DTO with the two columns the gate reads, over the default test brand. */
const brandWith = (chartStyle: NonNullable<Brand["chartStyle"]>, tradeUi: NonNullable<Brand["tradeUi"]>): Brand =>
  ({ ...TEST_BRANDS["invest254.com"]!, chartStyle, tradeUi });

interface Asked { seededAllowed?: boolean | undefined }
async function askRoutes(brand: Brand): Promise<{ feed: Asked; board: Asked; body: any }> {
  const asked: { feed: Asked; board: Asked } = { feed: {}, board: {} };
  const api: TestApi = await startTestApi({
    depsOverrides: {
      brandByHost: async () => brand,
      brandActivity: {
        async recent(_s, _l, opts) { asked.feed = { seededAllowed: opts?.seededAllowed }; return []; },
        async leaderboard(_s, _p, _l, opts) { asked.board = { seededAllowed: opts?.seededAllowed }; return []; },
      },
    },
  });
  try {
    await fetch(`${api.baseUrl}/api/v1/site/activity?host=invest254.com`);
    const res = await fetch(`${api.baseUrl}/api/v1/site/leaderboard?host=invest254.com`);
    return { ...asked, body: await res.json() };
  } finally { await api.close(); }
}

test("routes: the gate follows the brand's screen, on both the feed and the board", async () => {
  // Allowed: the candlestick trade UI on any chart, and the classic screen on the line chart.
  for (const b of [brandWith("candlestick", "candlestick"), brandWith("line", "classic"), brandWith("baseline", "candlestick")]) {
    const r = await askRoutes(b);
    assert.equal(r.feed.seededAllowed, true, `${b.chartStyle}/${b.tradeUi} feed`);
    assert.equal(r.board.seededAllowed, true, `${b.chartStyle}/${b.tradeUi} board`);
  }

  // Forbidden: the digits screen, the named broker terminal, and — the non-obvious one — a classic
  // brand on any non-line chart, which renders the broker terminal and not the classic screen.
  for (const b of [brandWith("line", "digits"), brandWith("candlestick", "digits"), brandWith("line", "broker"), brandWith("candlestick", "classic"), brandWith("area", "classic")]) {
    const r = await askRoutes(b);
    assert.equal(r.feed.seededAllowed, false, `${b.chartStyle}/${b.tradeUi} feed`);
    assert.equal(r.board.seededAllowed, false, `${b.chartStyle}/${b.tradeUi} board`);
  }
});

test("routes: the board states which metric produced the numbers it returned", async () => {
  const r = await askRoutes(brandWith("line", "classic"));
  assert.equal(r.body.period, "today");
  assert.equal(r.body.metric, "winnings", "the default is the product's metric, stated on the wire");
});

test("routes: metric and period are narrowed to literals, never passed through", async () => {
  const seen: Array<{ period: string; metric: string | undefined; limit: number }> = [];
  const api = await startTestApi({
    depsOverrides: {
      brandByHost: async () => brandWith("line", "classic"),
      brandActivity: {
        async recent() { return []; },
        async leaderboard(_s, period, limit, opts) { seen.push({ period, metric: opts?.metric, limit }); return []; },
      },
    },
  });
  try {
    const q = "host=invest254.com&period=%27%20or%201%3D1%20--&metric=%27%20or%201%3D1%20--";
    const body = await (await fetch(`${api.baseUrl}/api/v1/site/leaderboard?${q}`)).json() as any;
    assert.equal(body.period, "today");
    assert.equal(body.metric, "winnings");
    assert.deepEqual(seen, [{ period: "today", metric: "winnings", limit: 10 }]);

    // The cap is still a cap, and the default is still a top ten.
    await fetch(`${api.baseUrl}/api/v1/site/leaderboard?host=invest254.com&period=week&metric=profit&limit=9999`);
    assert.deepEqual(seen[1], { period: "week", metric: "profit", limit: 40 });
  } finally { await api.close(); }
});

// ---------------------------------------------------------------------------------------------
// JOB 4 — the feed has to read as a ROOM, not as one person
// ---------------------------------------------------------------------------------------------

/**
 * The shape of a real brand that went wrong in production (cpfmarket, observed via the public API):
 * the only real activity was a single prolific account's session from ~15 DAYS ago, repeated, while
 * the seeded rows were minutes old. The reserved floor had no age bound, so a quarter of a feed
 * described as live was held by fortnight-old rows from one trader — and because every client view
 * (the chat column and the notification card) reads THIS list, that one name was everywhere.
 */
const FIFTEEN_DAYS = 15 * 24 * 60 * 60;
function burstBrand() {
  return stubQuerier((sql) =>
    sql.includes("activity_seed")
      ? Array.from({ length: 40 }, (_, i) => ({
          kind: "win", name: `Seeded${i}`, amount_cents: 5_000_00, ago_seconds: 60 + i * 60,
        }))
      : // One account, one session, a fortnight ago — plus a second name so "real" is not one row.
        Array.from({ length: 12 }, (_, i) => ({
          kind: "win", username: i < 10 ? "mkeeee" : "mmekkkk",
          amount_cents: 300_00, ago_seconds: FIFTEEN_DAYS + i,
        })),
  );
}

test("feed: no single trader may own the window", async () => {
  const store = makePgBrandActivity(burstBrand());
  const rows = await store.recent(SITE_A, 40, { seededAllowed: true });

  const perName = new Map<string, number>();
  for (const r of rows) perName.set(r.name, (perName.get(r.name) ?? 0) + 1);
  const worst = [...perName.entries()].sort((a, b) => b[1] - a[1])[0]!;
  assert.ok(worst[1] <= 2, `"${worst[0]}" holds ${worst[1]} of ${rows.length} rows`);
  // And the room is actually a room.
  assert.ok(perName.size >= 20, `only ${perName.size} distinct names in ${rows.length} rows`);
});

test("feed: a fortnight-old real row does not hold a reserved slot against fresh activity", async () => {
  const store = makePgBrandActivity(burstBrand());
  const rows = await store.recent(SITE_A, 40, { seededAllowed: true });

  // Stale real rows are not EXCLUDED — they still compete — but they must not displace the fresh.
  const stale = rows.filter((r) => r.agoSeconds >= FIFTEEN_DAYS);
  assert.ok(stale.length <= 4, `${stale.length} fortnight-old rows reserved into a live feed`);
  assert.ok(rows.filter((r) => r.agoSeconds < 3600).length >= 20, 'the window should be mostly fresh');
});

test("feed: the client reads it NEWEST FIRST, which is what the notification depends on", async () => {
  const store = makePgBrandActivity(burstBrand());
  const rows = await store.recent(SITE_A, 40, { seededAllowed: true });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1]!.agoSeconds <= rows[i]!.agoSeconds, `row ${i} is older than its predecessor`);
  }
});

test("feed: a brand whose ONLY activity is old still shows it rather than nothing", async () => {
  // The age bound must not become a filter: with no seeded rows to replace them, the stale real
  // rows are all there is, and an empty feed would be a worse lie than an old one.
  const q = stubQuerier((sql) =>
    sql.includes("activity_seed") ? [] : [
      { kind: "win", username: "mkeeee", amount_cents: 300_00, ago_seconds: FIFTEEN_DAYS },
      { kind: "deposit", username: "wanjiku", amount_cents: 500_00, ago_seconds: FIFTEEN_DAYS + 5 },
    ],
  );
  const rows = await makePgBrandActivity(q).recent(SITE_A, 40, { seededAllowed: true });
  assert.equal(rows.length, 2);
});
