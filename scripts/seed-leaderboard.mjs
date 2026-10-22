/**
 * seed-leaderboard.mjs — fill a brand's public "Top Traders" board with SEEDED standings that
 * differ per period filter, the way a real board does.
 *
 * NOT IDEMPOTENT. `leaderboard_seed` (0194) has no natural key and this script is purely additive,
 * exactly like scripts/seed-activity.mjs: running it twice gives every seeded trader a second set
 * of buckets and doubles their standing. So the undo is the thing to know. Undo one brand:
 *
 *   delete from leaderboard_seed where site_id = (select id from sites where slug = '<slug>');
 *
 * And, once the brand has real players and no seeded data is wanted anywhere any more — the stated
 * product intent, one step, both seed tables:
 *
 *   truncate table activity_seed, leaderboard_seed;
 *
 * Neither command can hurt anything. 0194's header spells out why: nothing here touches
 * `positions`, `transactions`, `wallets`, `ledger_entries` or `deposit_commissions`, no `profiles`
 * row is invented, so no balance, GGR report, RTP figure, commission or provable-fairness
 * recomputation can move when these rows appear or disappear.
 *
 * ONE ROW IS A BUCKET, NOT A TOTAL AND NOT A TRADE. 0194 is read as
 *     select name, sum(trades), sum(winnings_cents) from leaderboard_seed
 *      where site_id = $1 and <window> group by name
 * so a seeded trader needs SEVERAL buckets scattered across the periods the board offers (today,
 * yesterday, this week, this month). That is what makes Today's board a different board from This
 * Month's — a single per-period total could not do it, and a row per trade would need thousands of
 * rows per name. Every trader seeded here gets at least one bucket in each window that exists at
 * the moment of seeding, plus post-dated buckets so the board keeps moving afterwards.
 *
 * POST-DATED BUCKETS. Same reasoning as the activity feed: a board seeded once and never again is
 * frozen, and tomorrow its Today tab is empty. Most buckets here are therefore in the future, and
 * the seed arm of the board query is being given `and created_at <= now()` so a bucket is invisible
 * until its moment arrives. Because `month` is `date_trunc('month', now())`, the post-dated tail
 * also carries the board over a month rollover instead of leaving an empty Month tab on the 1st.
 *
 * DAY BOUNDARIES. The read path truncates with `date_trunc('day'|'week'|'month', now())`, which
 * Postgres evaluates in the SESSION time zone, and we cannot know from here whether that is UTC or
 * Africa/Nairobi. So every bucket is placed between 03:00 and 23:00 Nairobi time (EAT = UTC+3, no
 * DST): a 03:00-or-later EAT instant is 00:00-or-later the SAME date in UTC, so it lands in the
 * same day, week and month either way. The band removed is the dead middle of the night, when
 * nobody is trading anyway.
 *
 *
 * SHARED HANDLES. Both seeders draw their handle pool from the same deterministic stream
 * (`SeedRng(seed, "handles")` in scripts/seed-names.mjs), and the smaller pool is a prefix of the
 * larger, so passing the SAME --seed to seed-activity.mjs and seed-leaderboard.mjs makes the two
 * surfaces agree: a handle topping the Top board is also seen depositing in the feed, which is how
 * a real brand looks. Different seeds give two unrelated casts, which is the giveaway.
 * Env:  DATABASE_URL (required — Supabase session-pooler :5432). Credentials are never written in
 *       this file; a hard-coded connection string in a repo is a leaked database.
 * Run:  DATABASE_URL=... node scripts/seed-leaderboard.mjs <site-slug> <traders 1..500> [--days=N]
 *                                                          [--seed=STRING] [--dry-run]
 *       DATABASE_URL=... node scripts/seed-leaderboard.mjs cpfmarket 60 --days=30 --dry-run
 */
import { Pool } from "pg";
import { SeedRng, makeHandles, rejectTaken, parseCli } from "./seed-names.mjs";
// The arrival curve is stated once, in the feed seeder, and reused here: a seeded trader settles
// trades at the same hours a seeded depositor deposits. Importing it has no side effects — that
// script only runs its main() when it is the entry point.
import { HOUR_WEIGHTS } from "./seed-activity.mjs";

/**
 * How far ahead buckets are post-dated, in days. A month by default: long enough that the board is
 * still moving after the next `date_trunc('month')` rollover, short enough that an operator who
 * changes their mind is deleting a month of invented standings and not a year of them.
 */
const DEFAULT_FORWARD_DAYS = 30;
const MAX_TRADERS = 500;
const MAX_DAYS = 120;
/** 0194: `trades between 1 and 500`. Buckets stay far below it — one bucket is a session, not a month. */
const MAX_TRADES_PER_BUCKET = 60;
/** 0194: `length(btrim(name)) between 1 and 40`. The generator caps at 16; asserted before insert. */
const MAX_NAME_LEN = 40;

const EAT_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
/** Buckets are confined to these EAT hours so UTC and EAT agree on which day they fall in. */
const FIRST_HOUR = 3;
const LAST_HOUR = 23;

/** Start of the EAT calendar day containing `ms`, as epoch ms. */
const startOfEatDay = (ms) => Math.floor((ms + EAT_OFFSET_MS) / DAY_MS) * DAY_MS - EAT_OFFSET_MS;
/** EAT calendar parts of `ms`. */
function eatParts(ms) {
  const d = new Date(ms + EAT_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay(), hour: d.getUTCHours() };
}

/**
 * An instant inside the EAT day `dayStart`, during trading hours, weighted by HOUR_WEIGHTS so a
 * bucket is far likelier to be settled at 20:00 than at 05:00.
 */
function instantInDay(rng, dayStart) {
  const hours = [];
  const weights = [];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) { hours.push(h); weights.push(HOUR_WEIGHTS[h]); }
  const hour = rng.weighted(hours, weights);
  return dayStart + hour * 3_600_000 + Math.floor(rng.next() * 3_600_000);
}

/**
 * The period windows that exist at `nowMs`, as inclusive EAT day ranges, plus the post-dated tail.
 *
 * `monthEarly` and `weekEarly` can be empty — on the 1st of the month there is no "earlier this
 * month", and on a Monday there is no "earlier this week". The caller must cope with that rather
 * than inventing a bucket in a window the board cannot show.
 */
export function windows(nowMs, forwardDays) {
  const today = startOfEatDay(nowMs);
  const { y, m, dow } = eatParts(nowMs);
  const monthStart = startOfEatDay(Date.UTC(y, m, 1, 12) - EAT_OFFSET_MS);
  // date_trunc('week') is ISO: Monday. getUTCDay() is 0=Sunday.
  const weekStart = today - ((dow + 6) % 7) * DAY_MS;
  const yesterday = today - DAY_MS;
  return {
    today, yesterday, weekStart, monthStart, nowMs,
    forwardEnd: today + Math.max(1, forwardDays) * DAY_MS,
    // Day ranges [from, toExclusive) in epoch ms, oldest first.
    monthEarly: monthStart < weekStart ? [monthStart, weekStart] : null,
    weekEarly: weekStart < yesterday ? [weekStart, yesterday] : null,
    yesterdayRange: [yesterday, today],
    todayRange: [today, today + DAY_MS],
  };
}

/** A bucket instant inside a [from, to) day range, trading hours only. */
function instantInRange(rng, [from, to]) {
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  return instantInDay(rng, from + rng.int(0, days - 1) * DAY_MS);
}

/** Tidy KES: winnings are quoted in round hundreds, like a payout screen, not 47,381. */
function tidyCents(kes) {
  const step = kes < 5_000 ? 100 : kes < 50_000 ? 500 : 1_000;
  return Math.max(0, Math.round(kes / step) * step) * 100;
}

/**
 * The whole batch of buckets, as plain data. Pure and deterministic given `seed`, so --dry-run
 * previews exactly what the insert writes.
 *
 * THE STANDINGS. A real board is a few names far ahead of a long tail, and it is NOT a smooth
 * curve — ranks 3 and 4 are usually close and then there is a gap. So:
 *  - a trader's intensity falls off with rank (1/(rank+1)^0.6) and is then multiplied by a
 *    per-trader lognormal jitter wide enough to reorder neighbours;
 *  - winnings are roughly proportional to trades (a per-trader average win per trade) times a
 *    per-bucket lognormal, so a trader can have a great day and a flat day;
 *  - no trader gets a bucket in every window, past the one each window requires, so the top three
 *    differ between Today and This Month.
 */
export function buildBuckets({ seed, traders, forwardDays, nowMs, taken = [] }) {
  const nameRng = new SeedRng(seed, "handles");
  const { kept, dropped } = rejectTaken(makeHandles(nameRng, traders), taken);
  if (!kept.length) throw new Error("every seeded handle collided with a real profiles.username");

  const rng = new SeedRng(seed, "buckets");
  const w = windows(nowMs, forwardDays);
  const rows = [];

  kept.forEach((name, i) => {
    if (name.trim().length < 1 || name.trim().length > MAX_NAME_LEN) {
      throw new Error(`handle '${name}' violates leaderboard_seed's 1..40 name CHECK`);
    }
    // Rank-shaped intensity, then a jitter wide enough that the final order is not the rank order.
    // The 0.45 floor is what keeps the tail credible: a bottom-of-the-board trader still shows a
    // handful of trades, not one.
    const jitter = Math.exp(rng.normal() * 0.4);
    // Capped: without a ceiling one lucky draw puts a single name an order of magnitude clear of
    // the board, which reads as a bug (or as a rigged house account) rather than as a good month.
    const intensity = Math.min(2.2, (0.45 + 1 / Math.pow(i + 1, 0.55)) * jitter);
    // Average gross winnings per settled trade, in KES: the stake level this trader plays at. Sized
    // so the top of the month board lands in the low hundreds of thousands of KES — aspirational
    // for a phone-first, M-Pesa-funded audience, and not a number nobody believes.
    const perTrade = Math.round(rng.range(180, 1_100) * (0.6 + 0.5 * intensity));

    // Every window that exists gets a bucket, so no period filter shows an empty board; then a
    // couple of extras in the recent past.
    const zones = [];
    if (w.monthEarly) zones.push(w.monthEarly);
    if (w.weekEarly) zones.push(w.weekEarly);
    zones.push(w.yesterdayRange);
    zones.push([w.today, w.today + DAY_MS]); // today, clamped below so it is not post-dated
    const extras = rng.int(1, 3);
    for (let e = 0; e < extras; e++) zones.push(w.weekEarly ?? w.yesterdayRange);

    /**
     * Then the post-dated tail, built DAY BY DAY rather than by scattering a few buckets over the
     * window: tomorrow's Today tab is only as good as the buckets that mature tomorrow, so each
     * future day needs its own handful. A trader appears on a given day with a probability set by
     * their intensity, so the big names are on the board most days, the tail drifts on and off, and
     * the standings genuinely change from one day to the next instead of being a fixed ranking with
     * a clock attached.
     */
    const pAppear = Math.min(0.9, 0.18 + 0.9 * Math.min(1, intensity / 1.6));
    const forwardDayCount = Math.max(1, Math.round((w.forwardEnd - (w.today + DAY_MS)) / DAY_MS));
    for (let d = 0; d < forwardDayCount; d++) {
      if (rng.next() > pAppear) continue;
      const dayStart = w.today + (d + 1) * DAY_MS;
      zones.push([dayStart, dayStart + DAY_MS]);
      if (rng.next() < 0.15) zones.push([dayStart, dayStart + DAY_MS]); // a second session that day
    }

    for (const zone of zones) {
      let at = instantInRange(rng, zone);
      // A bucket in TODAY's zone must be visible today, not post-dated into tonight, or the Today
      // tab is empty for an operator who seeds in the morning. Pull it back into the hours already
      // elapsed (or to a few minutes ago, if seeding before 03:00 EAT).
      // (If the script is run between midnight and 03:00 EAT there is no in-band instant left in
      // today, so the bucket lands in the small hours and a UTC-session read may count it as
      // yesterday's for those few hours. Seed in daylight and it cannot happen.)
      if (zone[0] === w.today && at > nowMs) {
        const elapsed = Math.max(0, nowMs - Math.max(w.today, w.today + FIRST_HOUR * 3_600_000));
        at = elapsed > 600_000 ? nowMs - Math.floor(rng.next() * elapsed) : nowMs - rng.int(120, 900) * 1000;
      }
      const trades = Math.min(MAX_TRADES_PER_BUCKET, Math.max(1, Math.round(intensity * rng.range(4, 16))));
      const kes = trades * perTrade * Math.exp(rng.normal() * 0.4);
      rows.push({ name, trades, winningsCents: tidyCents(kes), offsetSeconds: Math.round((at - nowMs) / 1000) });
    }
  });

  rows.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  return { rows, traders: kept.length, dropped, w };
}

/** Local aggregation of one period, exactly the `group by name` the read path does. */
function standings(rows, nowMs, fromMs, toMs) {
  const by = new Map();
  for (const r of rows) {
    const at = nowMs + r.offsetSeconds * 1000;
    if (at < fromMs || at >= toMs || at > nowMs) continue; // `created_at <= now()` as well
    const cur = by.get(r.name) ?? { trades: 0, cents: 0 };
    cur.trades += r.trades; cur.cents += r.winningsCents;
    by.set(r.name, cur);
  }
  return [...by.entries()].sort((a, b) => b[1].cents - a[1].cents);
}

export function printPreview({ rows, slug, traders, dropped, nowMs, forwardDays, w }) {
  const kes = (c) => `KES ${(c / 100).toLocaleString()}`;
  console.log(`leaderboard seed for '${slug}': ${traders} traders, ${rows.length} buckets, ` +
    `windows back to date_trunc('month') and ${forwardDays}d post-dated`);
  if (dropped.length) console.log(`dropped ${dropped.length} handle(s) already taken by a real profile: ${dropped.join(", ")}`);

  console.log("\nsample buckets (EAT timestamp, so the 03:00-23:00 placement is visible):");
  const step = Math.max(1, Math.floor(rows.length / 12));
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i];
    const at = new Date(nowMs + r.offsetSeconds * 1000 + EAT_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16);
    const tag = r.offsetSeconds < 0 ? "visible" : "arrives later";
    console.log(`  ${at} EAT  ${r.name.padEnd(17)} ${String(r.trades).padStart(3)} trades  ${kes(r.winningsCents).padStart(14)}  ${tag}`);
  }

  console.log("\nbuckets per day (EAT date, '>' = post-dated):");
  const perDay = new Map();
  for (const r of rows) {
    const at = nowMs + r.offsetSeconds * 1000;
    const key = new Date(startOfEatDay(at) + EAT_OFFSET_MS).toISOString().slice(0, 10);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const todayKey = new Date(w.today + EAT_OFFSET_MS).toISOString().slice(0, 10);
  for (const k of [...perDay.keys()].sort()) {
    console.log(`  ${k > todayKey ? ">" : " "} ${k}  ${String(perDay.get(k)).padStart(4)}  ${"#".repeat(Math.min(60, perDay.get(k)))}`);
  }

  for (const [label, from, to] of [
    ["today", w.today, w.today + DAY_MS],
    ["yesterday", w.yesterday, w.today],
    ["this week", w.weekStart, w.forwardEnd],
    ["this month", w.monthStart, w.forwardEnd],
  ]) {
    const board = standings(rows, nowMs, from, to).slice(0, 5);
    console.log(`\nboard as it would read RIGHT NOW — ${label} (top 5 of ${standings(rows, nowMs, from, to).length}):`);
    board.forEach(([name, v], i) => console.log(`  ${i + 1}. ${name.padEnd(17)} ${String(v.trades).padStart(4)} trades  ${kes(v.cents).padStart(14)}`));
    if (!board.length) console.log("  (empty)");
  }
  console.log("\n--dry-run: nothing was inserted.");
}

async function main() {
  const url = process.env.DATABASE_URL;
  const { pos, flags } = parseCli(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;
  const [slug, tradersArg] = pos;
  const traders = Number.parseInt(tradersArg ?? "", 10);
  const forwardDays = Number.parseInt(String(flags.days ?? DEFAULT_FORWARD_DAYS), 10);
  const usage = "usage: DATABASE_URL=... node scripts/seed-leaderboard.mjs <site-slug> <traders 1..500> [--days=N] [--seed=STRING] [--dry-run]";

  if (!url) { console.error("DATABASE_URL is required\n" + usage); process.exit(2); }
  if (!slug || !Number.isFinite(traders) || traders < 1 || traders > MAX_TRADERS ||
      !Number.isFinite(forwardDays) || forwardDays < 1 || forwardDays > MAX_DAYS) {
    console.error(usage); process.exit(2);
  }

  // Deterministic by default, so --dry-run previews exactly what the insert writes. Pass an
  // explicit --seed to get a DIFFERENT set of traders (the same args twice would duplicate).
  const seed = typeof flags.seed === "string" ? flags.seed : `${slug}:${traders}:${forwardDays}`;
  const nowMs = Date.now();

  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    const { rows: siteRows } = await pool.query("select id, slug from public.sites where slug = $1", [slug]);
    const site = siteRows[0];
    if (!site) { console.error(`no site with slug '${slug}'`); process.exit(1); }

    // Read-only, same reason as the feed seeder: a seeded handle must not wear a real player's name.
    const taken = (await pool.query("select username from public.profiles")).rows.map((r) => r.username);

    const built = buildBuckets({ seed, traders, forwardDays, nowMs, taken });
    const { rows } = built;

    if (dryRun) { printPreview({ ...built, slug: site.slug, nowMs, forwardDays }); return; }

    // One multi-row INSERT: all of the board's buckets or none of them, so a half-seeded board is
    // never left behind. The offset is SIGNED — negative is already visible, positive arrives later.
    await pool.query(
      `insert into public.leaderboard_seed (site_id, name, trades, winnings_cents, created_at)
       select $1, n, t, wc, now() + make_interval(secs => g)
         from unnest($2::text[], $3::int[], $4::bigint[], $5::double precision[]) as u(n, t, wc, g)`,
      [
        site.id,
        rows.map((r) => r.name),
        rows.map((r) => r.trades),
        rows.map((r) => r.winningsCents),
        rows.map((r) => r.offsetSeconds),
      ],
    );
    const future = rows.filter((r) => r.offsetSeconds >= 0).length;
    console.log(`seeded ${rows.length} leaderboard_seed buckets for ${built.traders} traders on '${site.slug}' ` +
      `(seed '${seed}'): ${rows.length - future} already visible, ${future} post-dated over the next ${forwardDays}d`);
    console.log(`undo: delete from leaderboard_seed where site_id = (select id from sites where slug = '${site.slug}');`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
