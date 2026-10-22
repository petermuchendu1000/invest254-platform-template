/**
 * seed-activity.mjs — fill a brand's public activity feed with SEEDED social-proof rows that keep
 * arriving, instead of a backfill that is frozen the moment it lands.
 *
 * NOT IDEMPOTENT. `activity_seed` (0193) has no natural key and this script is purely additive:
 * running it twice inserts two batches. That is deliberate (a second batch is sometimes what you
 * want), but it means the undo is the thing to know, not the re-run. Undo one brand:
 *
 *   delete from activity_seed where site_id = (select id from sites where slug = '<slug>');
 *
 * And, once the brand has real players and none of this is wanted anywhere any more — the stated
 * product intent, one step, both seed tables:
 *
 *   truncate table activity_seed, leaderboard_seed;
 *
 * Neither command can hurt anything: no balance, report, payout, commission or fairness audit reads
 * these tables. See the header of 0193 for why they are separate from the ledger.
 *
 * WHY THIS IS A SCRIPT AND NOT A FEATURE. Seeding a feed is a marketing decision taken once per
 * brand launch, by a person, who should have to type the brand and the count. Putting it behind an
 * API route would make invented activity something the product does on its own; a script that an
 * operator runs deliberately keeps a human on the hook for it.
 *
 * It writes ONLY to public.activity_seed (0193). It must never be made to write to `transactions`,
 * `positions`, `wallets` or `deposit_commissions`: those are the ledger, and a fabricated row in
 * them would move a real balance, a real report and a real commission.
 *
 * WHY THE ROWS ARE SPREAD FORWARD IN TIME. The read path (`apps/api/src/activity.pg.ts`) takes the
 * newest 40 seed rows by `created_at`. A backfill of 3,000 rows therefore shows the SAME 40 rows
 * forever: a week later every one of them reads "7d ago", which is worse than an empty feed,
 * because an empty feed is merely quiet while a feed of week-old deposits is visibly abandoned. So
 * most rows here are POST-DATED, and the seed arm of the read query is being given
 * `and created_at <= now()` so that a post-dated row is invisible until its moment arrives. The
 * feed then drips: a visitor on day 9 sees the rows that "happened" in the hours before they
 * opened it, which is the entire point — a newly arrived player has to see other people depositing.
 *
 * A short BACKFILL_DAYS tail is still seeded behind `now()` so the feed is populated the second the
 * script finishes rather than waiting for the first post-dated row to mature.
 *
 *
 * SHARED HANDLES. Both seeders draw their handle pool from the same deterministic stream
 * (`SeedRng(seed, "handles")` in scripts/seed-names.mjs), and the smaller pool is a prefix of the
 * larger, so passing the SAME --seed to seed-activity.mjs and seed-leaderboard.mjs makes the two
 * surfaces agree: a handle topping the Top board is also seen depositing in the feed, which is how
 * a real brand looks. Different seeds give two unrelated casts, which is the giveaway.
 * Env:  DATABASE_URL (required — Supabase session-pooler :5432). Credentials are never written in
 *       this file; a hard-coded connection string in a repo is a leaked database.
 * Run:  DATABASE_URL=... node scripts/seed-activity.mjs <site-slug> <count 1..20000> [--days=N]
 *                                                       [--seed=STRING] [--dry-run]
 *       DATABASE_URL=... node scripts/seed-activity.mjs cpfmarket 3000 --days=14 --dry-run
 */
import { Pool } from "pg";
import { SeedRng, makeHandles, rejectTaken, parseCli } from "./seed-names.mjs";

/**
 * Default forward window, in days. With the default 3,000 rows this is ~200 rows/day, ~8/hour on
 * average and ~25/hour at the evening peak. That is the number worth arguing about, so: 40 rows is
 * one screenful, so at the peak a screenful spans ~1.5 hours and at 4am it spans most of the night
 * — ages read "just now" to "2h ago" in the evening and "6h ago" in the small hours, which is how a
 * busy-but-not-fake feed reads. Ten times that would have a brand with no players claiming a
 * deposit every ten seconds, which nobody believes and which the support desk ends up explaining.
 */
const DEFAULT_FORWARD_DAYS = 14;
/** How far behind `now()` the tail reaches, so the feed is not empty at the instant of seeding. */
const BACKFILL_DAYS = 1;
const MAX_COUNT = 20_000;
const MAX_DAYS = 120;

/** KES, inclusive. A feed of only big wins reads as bait; a feed of only small ones reads as dead. */
const MIN_KES = 500;
const MAX_KES = 25_000;

/**
 * Deposits dominate, wins are common, withdrawals are the rarest. That ordering is roughly what the
 * real feed looks like, and a seeded feed that is mostly withdrawals would be a feed bragging about
 * money leaving — the opposite of the point.
 */
const KINDS = [
  ...Array(5).fill("deposit"),
  ...Array(3).fill("win"),
  ...Array(2).fill("withdrawal"),
];

/** Kenya is UTC+3 year-round (EAT, no DST), so the local hour is arithmetic, not a tz database. */
const EAT_OFFSET_HOURS = 3;

/**
 * Relative arrival rate by hour of the day in Nairobi time. Index 0 = 00:00 EAT.
 *
 * THE DISTRIBUTION. Rows are drawn from a non-homogeneous Poisson-ish process: each whole hour in
 * the window is a slot weighted by these numbers, every row picks a slot in proportion to its
 * weight and then a uniform instant inside it. Independent draws (rather than one row per fixed
 * tick) are what give the clumps and gaps a real feed has; the weights are what stop it being
 * uniform, which is the giveaway — a feed that posts the same number of deposits at 04:00 as at
 * 21:00 is not a feed of people.
 *
 * The curve: a trough at 03:00–05:00 (weight 0.08 at 4am, ~25x below peak — somebody is always
 * awake, but barely); a climb from 06:00 as phones come on; a flat, moderate working day; a lift
 * from 17:00 as people leave work; the peak at 20:00–22:00, which is when a phone-first,
 * M-Pesa-funded audience actually plays; and a fast fall after 23:00. Deliberately NOT zero
 * overnight: a feed whose newest row is six hours old at 05:00 reads as broken, and the early-riser
 * weight keeps something recent on screen at every hour.
 */
export const HOUR_WEIGHTS = [
  /* 00 */ 0.55, /* 01 */ 0.30, /* 02 */ 0.16, /* 03 */ 0.10, /* 04 */ 0.08, /* 05 */ 0.14,
  /* 06 */ 0.34, /* 07 */ 0.58, /* 08 */ 0.70, /* 09 */ 0.74, /* 10 */ 0.78, /* 11 */ 0.80,
  /* 12 */ 0.88, /* 13 */ 0.86, /* 14 */ 0.80, /* 15 */ 0.84, /* 16 */ 0.92, /* 17 */ 1.08,
  /* 18 */ 1.30, /* 19 */ 1.62, /* 20 */ 1.95, /* 21 */ 2.00, /* 22 */ 1.50, /* 23 */ 0.90,
];

/**
 * Signed second-offsets from `now()`, oldest first: negative is the backfill tail, positive is
 * post-dated and arrives later.
 *
 * Pure and deterministic given `rng`, so the --dry-run preview is the run.
 */
export function spreadSeconds({ rng, count, nowMs, backDays = BACKFILL_DAYS, forwardDays = DEFAULT_FORWARD_DAYS }) {
  if (!Number.isInteger(count) || count < 1) throw new Error("spreadSeconds: count must be a positive integer");
  const hoursBack = Math.max(0, Math.round(backDays * 24));
  const hoursFwd = Math.max(1, Math.round(forwardDays * 24));
  const slots = hoursBack + hoursFwd;

  // Slot i covers [base + i*3600, base + (i+1)*3600) seconds relative to now, aligned to whole
  // clock hours so a slot's weight is the weight of exactly one hour of the day.
  const hourStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const base = (hourStartMs - nowMs) / 1000 - hoursBack * 3600;
  const baseUtcHour = new Date(hourStartMs).getUTCHours();

  const cum = new Float64Array(slots);
  let total = 0;
  for (let i = 0; i < slots; i++) {
    const utcHour = (((baseUtcHour - hoursBack + i) % 24) + 24) % 24;
    total += HOUR_WEIGHTS[(utcHour + EAT_OFFSET_HOURS) % 24];
    cum[i] = total;
  }

  const lo = base;
  const hi = base + slots * 3600;
  const out = new Array(count);
  for (let k = 0; k < count; k++) {
    const target = rng.next() * total;
    // Binary search the slot whose cumulative weight first exceeds the draw.
    let a = 0, b = slots - 1;
    while (a < b) { const m = (a + b) >> 1; if (cum[m] <= target) a = m + 1; else b = m; }
    const t = base + a * 3600 + rng.next() * 3600;
    out[k] = Math.min(hi - 1, Math.max(lo, Math.round(t)));
  }
  return out.sort((x, y) => x - y);
}

/** Round to a tidy KES figure: people deposit 1,500, not 1,487. */
export function amountCents(rng) {
  const kes = MIN_KES + rng.next() * (MAX_KES - MIN_KES);
  const step = kes < 2_000 ? 50 : kes < 10_000 ? 100 : 500;
  return Math.round(kes / step) * step * 100;
}

const fmtAge = (s) => {
  const a = Math.abs(s);
  const v = a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${(a / 3600).toFixed(1)}h` : `${(a / 86400).toFixed(1)}d`;
  return s < 0 ? `${v} ago` : `in ${v}`;
};

/** The whole batch, as plain data. Pure, so the dry run and the insert cannot disagree. */
export function buildSeeds({ seed, count, forwardDays, nowMs, taken = [] }) {
  // One handle pool reused across rows: a real feed has repeat depositors, and ~12 rows per handle
  // over the window is a plausible number of visits. Capped so a huge count does not need a
  // correspondingly huge pool of invented people.
  const poolSize = Math.min(600, Math.max(40, Math.ceil(count / 12)));
  const nameRng = new SeedRng(seed, "handles");
  const { kept, dropped } = rejectTaken(makeHandles(nameRng, poolSize), taken);
  if (kept.length < 20) throw new Error(`only ${kept.length} seeded handles survived the collision check against profiles.username`);

  const rng = new SeedRng(seed, "rows");
  const offsets = spreadSeconds({ rng, count, nowMs, forwardDays });

  // Some handles are far more active than others — the feed's "regulars" — which is what a real
  // feed shows and what a flat pick does not. Zipf-ish: weight 1/(rank+3).
  const weights = kept.map((_, i) => 1 / (i + 3));

  const lastSeenAt = new Map();
  const seeds = offsets.map((offsetSeconds) => {
    // Avoid the same handle appearing twice inside 20 minutes; two deposits a minute apart from one
    // name is the single most bot-like thing a feed can show.
    let name = kept[0];
    for (let attempt = 0; attempt < 8; attempt++) {
      name = rng.weighted(kept, weights);
      if (offsetSeconds - (lastSeenAt.get(name) ?? -Infinity) > 1_200) break;
    }
    lastSeenAt.set(name, offsetSeconds);
    return { kind: rng.pick(KINDS), name, amountCents: amountCents(rng), offsetSeconds };
  });
  return { seeds, poolSize: kept.length, dropped };
}

/** The --dry-run report: a sample plus enough shape that the arrival pattern can be eyeballed. */
export function printPreview({ seeds, slug, count, forwardDays, poolSize, dropped, nowMs }) {
  const past = seeds.filter((s) => s.offsetSeconds < 0);
  console.log(`seed for '${slug}': ${count} rows, ${poolSize} distinct handles, ` +
    `${BACKFILL_DAYS}d backfill + ${forwardDays}d post-dated`);
  if (dropped.length) console.log(`dropped ${dropped.length} handle(s) already taken by a real profile: ${dropped.join(", ")}`);

  console.log("\nnewest rows already visible (what a visitor sees the moment this run lands):");
  for (const s of past.slice(-8)) {
    console.log(`  ${s.kind.padEnd(10)} ${s.name.padEnd(17)} KES ${String((s.amountCents / 100).toLocaleString()).padStart(7)}  ${fmtAge(s.offsetSeconds)}`);
  }
  console.log("\nfirst rows that arrive later (invisible until created_at <= now()):");
  for (const s of seeds.filter((s) => s.offsetSeconds >= 0).slice(0, 6)) {
    console.log(`  ${s.kind.padEnd(10)} ${s.name.padEnd(17)} KES ${String((s.amountCents / 100).toLocaleString()).padStart(7)}  ${fmtAge(s.offsetSeconds)}`);
  }

  // Rows per day across the window: the backfill tail, then each post-dated day.
  const perDay = new Map();
  for (const s of seeds) perDay.set(Math.floor(s.offsetSeconds / 86_400), (perDay.get(Math.floor(s.offsetSeconds / 86_400)) ?? 0) + 1);
  console.log("\nrows per day (day 0 = now onwards, -1 = the backfill tail):");
  for (const d of [...perDay.keys()].sort((a, b) => a - b)) {
    const n = perDay.get(d);
    console.log(`  day ${String(d).padStart(3)}  ${String(n).padStart(5)}  ${"#".repeat(Math.round(n / Math.max(1, count / 400)))}`);
  }

  // Hour-of-day histogram in EAT over the whole window: this is the evening peak / 4am trough.
  const perHour = new Array(24).fill(0);
  for (const s of seeds) {
    const d = new Date(nowMs + s.offsetSeconds * 1000);
    perHour[(d.getUTCHours() + EAT_OFFSET_HOURS) % 24]++;
  }
  const peak = Math.max(...perHour);
  console.log("\narrivals by hour of day (EAT), all days pooled:");
  for (let h = 0; h < 24; h++) {
    console.log(`  ${String(h).padStart(2, "0")}:00 ${String(perHour[h]).padStart(5)}  ${"#".repeat(Math.round((perHour[h] / peak) * 40))}`);
  }
  console.log(`\n--dry-run: nothing was inserted.`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  const { pos, flags } = parseCli(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;
  const [slug, countArg] = pos;
  const count = Number.parseInt(countArg ?? "", 10);
  const forwardDays = Number.parseInt(String(flags.days ?? DEFAULT_FORWARD_DAYS), 10);
  const usage = "usage: DATABASE_URL=... node scripts/seed-activity.mjs <site-slug> <count 1..20000> [--days=N] [--seed=STRING] [--dry-run]";

  if (!url) { console.error("DATABASE_URL is required\n" + usage); process.exit(2); }
  if (!slug || !Number.isFinite(count) || count < 1 || count > MAX_COUNT ||
      !Number.isFinite(forwardDays) || forwardDays < 1 || forwardDays > MAX_DAYS) {
    console.error(usage); process.exit(2);
  }

  // Deterministic by default, so --dry-run previews exactly what the insert writes. Pass an
  // explicit --seed to get a DIFFERENT batch (the same args twice would otherwise duplicate rows).
  const seed = typeof flags.seed === "string" ? flags.seed : `${slug}:${count}:${forwardDays}`;
  const nowMs = Date.now();

  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    const { rows } = await pool.query("select id, slug from public.sites where slug = $1", [slug]);
    const site = rows[0];
    if (!site) { console.error(`no site with slug '${slug}'`); process.exit(1); }

    // Read-only: seeded handles are synthetic, but profiles.username is player-chosen and globally
    // unique, so a handle that happens to match one would be social proof wearing a real person's
    // name. Dropped rather than mangled.
    const taken = (await pool.query("select username from public.profiles")).rows.map((r) => r.username);

    const { seeds, poolSize, dropped } = buildSeeds({ seed, count, forwardDays, nowMs, taken });

    if (dryRun) { printPreview({ seeds, slug: site.slug, count, forwardDays, poolSize, dropped, nowMs }); return; }

    // One multi-row INSERT: the whole run lands or none of it does, so a half-seeded feed is never
    // left behind for someone to puzzle over. unnest keeps it to a single bind for any count, and
    // the offset is SIGNED — negative is the backfill tail, positive is post-dated.
    await pool.query(
      `insert into public.activity_seed (site_id, kind, name, amount_cents, created_at)
       select $1, k, n, a, now() + make_interval(secs => g)
         from unnest($2::text[], $3::text[], $4::bigint[], $5::double precision[]) as t(k, n, a, g)`,
      [
        site.id,
        seeds.map((s) => s.kind),
        seeds.map((s) => s.name),
        seeds.map((s) => s.amountCents),
        seeds.map((s) => s.offsetSeconds),
      ],
    );
    const future = seeds.filter((s) => s.offsetSeconds >= 0).length;
    console.log(`seeded ${seeds.length} activity_seed rows for '${site.slug}' (seed '${seed}'): ` +
      `${seeds.length - future} in the last ${BACKFILL_DAYS}d, ${future} post-dated over the next ${forwardDays}d`);
    console.log(`undo: delete from activity_seed where site_id = (select id from sites where slug = '${site.slug}');`);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so the pure helpers above can be imported by the test beside it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
