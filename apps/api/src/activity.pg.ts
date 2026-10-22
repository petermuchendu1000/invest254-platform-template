/**
 * The brand's recent REAL activity: deposits that settled, withdrawals that were paid, and trades
 * that won. This is what the candlestick screen's Live Chat shows between players' messages.
 *
 * Every row the QUERIES here read out of `transactions` and `positions` describes something that
 * actually happened to a real account on this brand, and that stays true: those arms were never
 * going to grow a generated row. The screen it feeds was copied from a page whose equivalent feed
 * is wholly generated — its own rows come back typed `system_simulated`, naming withdrawals nobody
 * made.
 *
 * SEEDED ROWS. On top of the real events the feed now also carries rows from `activity_seed` (0193),
 * which the product owner seeds so a newly-launched brand's feed is not empty. They are kept in
 * their own table, outside every money table, so the ledger stays exactly as correct as it was and
 * the seeds can be deleted wholesale at any time. Nothing downstream of them moves a balance; what
 * they do move is what a person about to deposit believes about this brand, which is the reason the
 * boundary is drawn in the schema rather than in a flag on a real row.
 *
 * PRIVACY. A public feed naming real people and real money has to give up as little as it can:
 *  - the name is the account's own username, truncated, never a phone number, an id or an email;
 *  - an account with no username is shown as "A trader" rather than being identified another way;
 *  - only the amount and a coarse age go out — no transaction id, no receipt, no exact timestamp;
 *  - demo and practice activity is excluded, because it did not happen with money;
 *  - the query is site-scoped, so one brand's feed can never carry another brand's players.
 */
export interface ActivityQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

/** One thing that happened, as the feed states it. */
export interface BrandActivityItem {
  kind: 'deposit' | 'withdrawal' | 'win';
  /** The trader's display name, already truncated. Never an id, a phone or an email. */
  name: string;
  amountCents: number;
  /** Whole seconds ago, so the client can say "2m ago" without being handed a wall-clock time. */
  agoSeconds: number;
  /**
   * True for a row that came from `activity_seed` (0193) rather than from a settled transaction or
   * position.
   *
   * Carried so the distinction survives in the API payload itself: an operator, an auditor, or
   * whoever next reads this endpoint can tell seeded social proof from a real event without
   * joining anything. The client does not have to use it, and today does not — but the server
   * should never be the thing that makes the two indistinguishable.
   */
  seeded?: boolean;
}

/** One trader on the board, as the Top tab lists them. */
export interface LeaderboardRow {
  rank: number;
  name: string;
  trades: number;
  /**
   * The amount the board RANKED this row by, in cents — total winnings by default, net profit when
   * the caller asks for the `profit` metric.
   *
   * The name is kept because it is the field the client already renders (TopTradersPane), and this
   * DTO is public; a rename would be a breaking change to a payload for the sake of a word. The
   * route echoes which metric produced it, so the number is never ambiguous on the wire.
   */
  profitCents: number;
  /**
   * True for a row aggregated out of `leaderboard_seed` (0194) rather than out of settled positions.
   * Carried for the same reason `BrandActivityItem.seeded` is: the server must never be the thing
   * that makes seeded social proof indistinguishable from a real result.
   */
  seeded?: boolean;
}

/** The windows the mock's four chips select. */
export type LeaderboardPeriod = 'today' | 'yesterday' | 'week' | 'month';

/**
 * What the board is RANKED by.
 *
 *  - `winnings` (the default, and the product decision): total GROSS winnings. For real rows that is
 *    `sum(positions.payout)` over the winning positions — see the note on the query.
 *  - `profit`: net `sum(positions.pnl)`, which is what the board used to rank by and is kept
 *    available because it is the honest number for real money.
 */
export type LeaderboardMetric = 'winnings' | 'profit';

/** Everything beyond the window and the cap that a caller may ask the board for. */
export interface LeaderboardOptions {
  metric?: LeaderboardMetric;
  /**
   * Whether this brand's screen may show SEEDED rows (`seededSocialProofAllowed`, shared/chart.ts).
   * Defaults to TRUE so every existing caller behaves exactly as it does today; the route computes
   * it from the brand and passes it, which is where the gate actually bites.
   */
  seededAllowed?: boolean;
}

/** Same gate for the feed. Defaults to TRUE for the same reason. */
export interface ActivityOptions {
  seededAllowed?: boolean;
}

export interface BrandActivityStore {
  recent(siteId: string, limit: number, opts?: ActivityOptions): Promise<BrandActivityItem[]>;
  leaderboard(siteId: string, period: LeaderboardPeriod, limit: number, opts?: LeaderboardOptions): Promise<LeaderboardRow[]>;
}

/**
 * Each chip's window, as SQL the query can drop in. Closed at both ends so a day means that day.
 *
 * `{at}` is the timestamp column the window applies to, because TWO sources are now windowed by the
 * same chip: `positions.settled_at` for the real board and `leaderboard_seed.created_at` for the
 * seeded one. One template rather than two copies, so a chip cannot come to mean different spans on
 * the two sources — which would show a seeded trader in Today's board and a real one only in This
 * Month's.
 *
 * STRING-INTERPOLATED INTO SQL, and safe for exactly one reason: `period` is validated against this
 * record's own keys before it gets here (app.activity.ts), and `at` is a column name written as a
 * literal at the two call sites below — NEITHER is ever request text. Any axis added here must keep
 * that property: validate the key against the map and interpolate the MAP'S VALUE, never the input.
 */
const WINDOW_AT: Record<LeaderboardPeriod, string> = {
  today: "{at} >= date_trunc('day', now())",
  yesterday: "{at} >= date_trunc('day', now()) - interval '1 day' and {at} < date_trunc('day', now())",
  week: "{at} >= date_trunc('week', now())",
  month: "{at} >= date_trunc('month', now())",
};

/** The window predicate for one chip over one timestamp column. Exported for the drift test. */
export function leaderboardWindowSql(period: LeaderboardPeriod, at: string): string {
  return (WINDOW_AT[period] ?? WINDOW_AT.today).split('{at}').join(at);
}

/**
 * The aggregate each metric ranks by, over the REAL source.
 *
 * `winnings` sums `payout`, not `pnl`. Settlement writes both on the same row —
 * `payout = p_payout, pnl = p_payout - stake` (fn_settle_position, 0010 and every reissue since,
 * latest 0176) — so `payout` is the gross amount credited back on a win and `pnl` is that minus the
 * stake, i.e. the net. "Total winnings" is the gross one, so it is `payout`; and it is taken only
 * over the rows settlement called a WIN, because a loss settles with payout 0 and must contribute
 * nothing rather than being silently included as a zero.
 *
 * Interpolated into SQL under exactly the same rule as WINDOW_AT: the KEY is validated against this
 * record before it reaches the query, and the value interpolated is this record's own, never the
 * caller's text.
 */
const METRIC_SQL: Record<LeaderboardMetric, string> = {
  winnings: "coalesce(sum(o.payout) filter (where o.result = 'win'), 0)",
  profit: 'sum(o.pnl)',
};

/**
 * Shorten a username for public display: the first word, capped, with nothing revealing kept.
 *
 * Usernames on this product are chosen by the player and are already public to support staff, but a
 * feed on the trade screen is a different audience, so this keeps the first token only — "wanjiku"
 * from "wanjiku_254" — which is the shape the mock uses and the least that still reads as a person.
 */
export function publicName(username: string | null | undefined): string {
  const first = String(username ?? '').trim().split(/[\s_.\-@]+/)[0] ?? '';
  const cleaned = first.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 12);
  if (cleaned.length < 2) return 'A trader';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * Fill `limit` slots from two sources, newest/best first, with a GUARANTEED FLOOR for real rows.
 *
 * Both of the obvious rules are wrong, and each is wrong in a way that only shows up on a real
 * brand:
 *
 *   "sort the union by recency and cut"  — the seed table holds thousands of rows minutes apart, so
 *     every slot goes to seeded rows and a brand's genuine deposits and wins, the only events on
 *     the screen that actually happened, are never seen again. Social proof that hides the real
 *     thing it is proof of is worse than an empty feed.
 *
 *   "real rows take every slot they can fill"  — what this function did first, and it made the
 *     whole feature inert on the one brand it was built for. cpfmarket has more than `limit` real
 *     events in its history, so real rows filled all 40 slots and the 3000 seeded rows were
 *     invisible — while the newest of those 40 real rows was 29 HOURS old and several were two
 *     weeks old. A feed of fortnight-old activity above a deposit button is exactly the dead-product
 *     look the seed exists to fix. Verified against the live API, which is the only place either
 *     rule can be judged: `seeded=0, real=40`.
 *
 * So: real rows are guaranteed a floor of the slots (they can never be crowded out), and every
 * remaining slot is contested by both sources on merit — which for the feed means recency, so a
 * seeded row from ten minutes ago outranks a real one from last fortnight, and a REAL deposit from
 * two minutes ago outranks both. The floor is what the first rule protects; the contest is what
 * makes a quiet brand look alive. A brand with plenty of recent real activity still fills the feed
 * with it, because it wins the contest outright rather than by reservation.
 *
 * `key` is ascending-is-first (seconds-ago for the feed, negated amount for the board), which is why
 * the two callers can share this.
 */
/** Share of the slots real rows can never be pushed out of. */
const REAL_FLOOR_SHARE = 0.25;

/**
 * How recent a REAL row must be to claim one of the reserved slots.
 *
 * The floor exists so a brand's genuine events are never crowded out by marketing copy, and that is
 * right — but it was unbounded in TIME, so it reserved a quarter of a feed described as live for
 * events that were a fortnight old. Observed on cpfmarket: the newest real rows in the window were
 * 21,880 minutes (about 15 days) old, four of them the same account's wins from one session, and
 * they held reserved slots against seeded rows minutes old.
 *
 * Beyond this age a real row is not news and stops being RESERVED. It is not excluded: it still
 * competes for the contested slots on recency exactly like everything else, so a quiet brand whose
 * only activity is old still shows it. What it no longer does is displace something fresher.
 */
const REAL_FLOOR_MAX_AGE_S = 48 * 60 * 60;

/**
 * How many rows one NAME may hold in a single feed window.
 *
 * A feed is social proof, which means it has to read as a room rather than as one person. An
 * account that trades in bursts produces a run of events seconds apart and, sorted by recency,
 * takes the whole top of the window — so the screen names the same trader over and over, both in
 * the chat column and on every notification card the client pops from this list. Two is enough to
 * show somebody is active without letting them own the feed.
 */
const MAX_ROWS_PER_NAME = 2;

/**
 * Keep at most `cap` rows per name, preserving order.
 *
 * Order is already merit order (newest first for the feed), so walking it forwards keeps each
 * trader's BEST rows and drops their repeats.
 */
function capPerName<T extends { name: string }>(rows: readonly T[], cap: number): T[] {
  const count = new Map<string, number>();
  const out: T[] = [];
  for (const row of rows) {
    const k = row.name.trim().toLowerCase();
    const n = count.get(k) ?? 0;
    if (n >= cap) continue;
    count.set(k, n + 1);
    out.push(row);
  }
  return out;
}

function mergeByMeritWithRealFloor<T>(
  real: readonly T[], seeded: readonly T[], limit: number, key: (x: T) => number,
): T[] {
  if (limit <= 0) return [];
  const byKey = (a: T, b: T): number => key(a) - key(b);
  const realSorted = [...real].sort(byKey);
  const seededSorted = [...seeded].sort(byKey);

  // The floor is a floor, not a quota: if there are fewer real rows than that, the rest of the
  // slots simply go to the contest, and if real rows win more than the floor on merit they keep
  // them all.
  const floor = Math.min(realSorted.length, Math.ceil(limit * REAL_FLOOR_SHARE));
  const reserved = realSorted.slice(0, floor);

  const contested = [...realSorted.slice(floor), ...seededSorted].sort(byKey);
  return [...reserved, ...contested.slice(0, limit - reserved.length)].sort(byKey);
}

export function makePgBrandActivity(q: ActivityQuerier): BrandActivityStore {
  return {
    async recent(siteId, limit, opts) {
      /**
       * Deposits and withdrawals that COMPLETED, and positions that WON, newest first.
       *
       * One statement rather than three round trips, and `limit` is applied inside each arm as well
       * as outside so a brand with a million settled deposits still reads an index-sized slice.
       *
       * EACH ARM IS PARENTHESISED, and must stay that way: in Postgres an ORDER BY or LIMIT written
       * directly on a UNION arm belongs to the whole UNION, so without the brackets this is a
       * syntax error (42601) and the route 500s. Neither tsc nor a unit test can see that — nothing
       * but a real database parses this string — which is how it reached production once already.
       * Demo and practice rows are excluded in the positions arm; transactions carry no demo flag
       * because a demo wallet never reaches a payment provider.
       */
      const r = await q.query(
        `select kind, username, amount_cents, ago_seconds from (
           (select 'deposit' as kind, p.username,
                   t.amount as amount_cents,
                   extract(epoch from (now() - t.created_at)) as ago_seconds,
                   t.created_at as at
              from transactions t join profiles p on p.id = t.user_id
             where t.site_id = $1 and t.kind = 'deposit' and t.status = 'success'
             order by t.created_at desc limit $2)
           union all
           (select 'withdrawal', p.username, t.amount,
                   extract(epoch from (now() - t.created_at)),
                   t.created_at
              from transactions t join profiles p on p.id = t.user_id
             where t.site_id = $1 and t.kind = 'withdrawal' and t.status = 'success'
             order by t.created_at desc limit $2)
           union all
           (select 'win', p.username, o.payout,
                   extract(epoch from (now() - o.settled_at)),
                   o.settled_at
              from positions o join profiles p on p.id = o.user_id
             where o.site_id = $1 and o.result = 'win' and o.status = 'settled'
               and o.settled_at is not null and o.payout > 0
               and coalesce(o.demo, false) = false and coalesce(o.practice, false) = false
             order by o.settled_at desc limit $2)
         ) rows
         order by at desc limit $2`,
        [siteId, limit],
      );
      const real: BrandActivityItem[] = r.rows.map((x) => ({
        kind: x.kind === 'withdrawal' ? 'withdrawal' : x.kind === 'win' ? 'win' : 'deposit',
        name: publicName(x.username as string | null),
        amountCents: Math.max(0, Math.round(Number(x.amount_cents ?? 0))),
        agoSeconds: Math.max(0, Math.round(Number(x.ago_seconds ?? 0))),
      }));

      /**
       * THE GATE (shared/chart.ts `seededSocialProofAllowed`). Seeded social proof is allowed on the
       * candlestick trade UI and on the ordinary classic screen, and never on the digits screen or
       * the broker terminal — and it is enforced HERE, server-side, so no client can ask for seeded
       * rows its brand is not meant to have. A gated brand does not even cost the second round trip.
       *
       * The REAL arms above have already run and are returned exactly as they always were: the gate
       * only ever removes seeded rows.
       */
      if (opts?.seededAllowed === false) return real.slice(0, limit);

      /**
       * The SEEDED rows (0193), merged in so a brand nobody has deposited on yet still has a feed.
       *
       * A SECOND statement rather than a fourth UNION arm, because the arm above is the one piece of
       * SQL in this file that has already broken production once and the comment on it says why: its
       * brackets are load-bearing and nothing but a real database parses them. Editing that string
       * to bolt marketing copy onto it risks the route for the sake of saving a round trip against a
       * tiny, single-index table. The merge is then done here, where it is plain to read.
       *
       * `name` is taken as stored and NOT passed through publicName: that function exists to shrink
       * a real player's username to the least that still reads as a person, and there is no player
       * behind a seed row to protect — running it would only mangle the display name on purpose.
       *
       * `created_at <= now()` is what makes a static table into a LIVE feed. Without it the newest
       * 40 seed rows are the newest 40 forever: the feed never changes again, and a week later every
       * row on it reads "7d ago". With it the seeding script can POST-DATE rows and they arrive on
       * their own schedule — a month of seeded activity revealing itself at the pace it was seeded
       * at. The index is already (site_id, created_at desc), so the bound is a scan boundary, not a
       * filter. (A separate script owns the writing; this is the read path it needs.)
       */
      const s = await q.query(
        `select kind, name, amount_cents,
                extract(epoch from (now() - created_at)) as ago_seconds
           from public.activity_seed
          where site_id = $1 and created_at <= now()
          order by created_at desc
          limit $2`,
        [siteId, limit],
      );
      const seeded: BrandActivityItem[] = s.rows.map((x) => ({
        kind: x.kind === 'withdrawal' ? 'withdrawal' : x.kind === 'win' ? 'win' : 'deposit',
        name: String(x.name ?? '').trim() || 'A trader',
        amountCents: Math.max(0, Math.round(Number(x.amount_cents ?? 0))),
        agoSeconds: Math.max(0, Math.round(Number(x.ago_seconds ?? 0))),
        seeded: true,
      }));

      // Real rows are guaranteed a floor of the slots and the rest is contested on recency, so a
      // ten-minute-old seeded row outranks a fortnight-old real one while a two-minute-old REAL
      // deposit outranks both. The age is the sort key the DTO already carries, so the merged order
      // is exactly the order the client renders. See the helper for why neither "real takes
      // everything" nor "sort the union and cut" works.
      /**
       * Only RECENT real rows claim the reserved floor; older ones drop into the contest.
       *
       * They are passed in as part of the contested pool rather than discarded, so nothing is lost
       * — a brand whose only activity is old still shows it, it just cannot reserve a quarter of a
       * live feed with it. See REAL_FLOOR_MAX_AGE_S.
       */
      /**
       * The cap is applied to each POOL first, and the merge still runs at `limit`.
       *
       * Capping the merged result instead would return a short feed, and widening the merge to
       * compensate would quietly break the floor: reserved rows are sorted back into recency order,
       * so trimming a wider result to `limit` can cut the very rows the floor reserved. Thinning
       * the inputs keeps `mergeByMeritWithRealFloor` working on exactly the window it documents.
       *
       * Both pools arrive newest-first from SQL, and the contested pool is re-sorted because it is
       * two sources concatenated — so `capPerName` keeps each trader's FRESHEST rows, not whichever
       * happened to be read first.
       */
      const byAge = (a: BrandActivityItem, b: BrandActivityItem) => a.agoSeconds - b.agoSeconds;
      const freshReal = capPerName(real.filter((x) => x.agoSeconds <= REAL_FLOOR_MAX_AGE_S), MAX_ROWS_PER_NAME);
      const staleReal = real.filter((x) => x.agoSeconds > REAL_FLOOR_MAX_AGE_S);
      const contested = capPerName([...staleReal, ...seeded].sort(byAge), MAX_ROWS_PER_NAME);

      // The trailing cap catches the one case the two above cannot: a name present in BOTH pools.
      return capPerName(
        mergeByMeritWithRealFloor(freshReal, contested, limit, (x) => x.agoSeconds),
        MAX_ROWS_PER_NAME,
      );
    },

    async leaderboard(siteId, period, limit, opts) {
      const metric: LeaderboardMetric = opts?.metric === 'profit' ? 'profit' : 'winnings';
      const amount = METRIC_SQL[metric];

      /**
       * Ranked by TOTAL WINNINGS over the window by default, with net profit still on offer.
       *
       * The board used to rank by net `sum(o.pnl)` only, and the note here used to say that was the
       * only ranking that is not misleading — the argument being that winnings alone puts whoever
       * staked most on top whether or not they are up. That argument is still true and is why
       * `profit` is kept as a metric. The product decision is nonetheless to SHOW winnings: the net
       * board is near-empty on a quiet brand (see 0194), and `metric` is now an explicit axis rather
       * than an assumption buried in one aggregate, so which number is on screen is a choice the
       * route states out loud instead of a thing this file decides for everyone.
       *
       * `amount` and the window are string-interpolated, and both are safe for exactly one reason:
       * the KEYS are validated against METRIC_SQL / WINDOW_AT before they reach here
       * (app.activity.ts), so what lands in the SQL is always one of this file's own literals and
       * never request text. Preserve that for any axis added later.
       *
       * `group by p.username` collapses two real accounts that happen to share a username into one
       * board row, which it did not before 0190 made usernames non-unique. That is NOT what one
       * would write today — a board row should be one trader, so the grouping should be on the
       * account — but changing it would change what real players see on every brand's board, and
       * this change is additive by contract. Two things make it survivable in the meantime: the
       * username is a display name and nothing else since 0190 (nothing authenticates by it), and
       * `publicName` already collapses distinct usernames to the same first token for display
       * anyway ("wanjiku_254" and "wanjiku.m" both render as "Wanjiku"). Recorded here so the next
       * reader knows it was seen and not missed.
       *
       * Demo and practice are excluded for the same reason they are excluded from the feed.
       */
      const r = await q.query(
        `select p.username, count(*)::int as trades, ${amount}::bigint as amount_cents
           from positions o join profiles p on p.id = o.user_id
          where o.site_id = $1 and o.status = 'settled' and o.settled_at is not null
            and coalesce(o.demo, false) = false and coalesce(o.practice, false) = false
            and ${leaderboardWindowSql(period, 'o.settled_at')}
          group by p.username
         having ${amount} > 0
          order by ${amount} desc
          limit $2`,
        [siteId, limit],
      );
      const real: LeaderboardRow[] = r.rows.map((x) => ({
        rank: 0,
        name: publicName(x.username as string | null),
        trades: Math.max(0, Math.round(Number(x.trades ?? 0))),
        profitCents: Math.max(0, Math.round(Number(x.amount_cents ?? 0))),
      }));

      /**
       * The SEEDED board rows (0194), under the SAME gate as the feed, and only for the winnings
       * metric: `leaderboard_seed` stores gross `winnings_cents` and no stake, so it has no honest
       * answer to "net profit". Asking it for one would mean reading winnings and calling them
       * profit, which is the single thing this whole two-table arrangement exists to avoid. A
       * `profit` board therefore stays exactly as real — and as sparse — as it is today.
       */
      if (opts?.seededAllowed === false || metric !== 'winnings') return rank(real.slice(0, limit));

      /**
       * One row is a BUCKET (some trades, some winnings, at a point in time), so the seeded source
       * is aggregated `group by name` INSIDE the window — the same shape as the real query above,
       * which is what makes a seeded trader's standing differ between Today and This Month the way a
       * real one's does. `created_at <= now()` for the same reason the feed has it: a post-dated
       * bucket must not count before it arrives.
       *
       * `name` is shown verbatim, NOT through publicName, for the reason given on the feed's seed
       * rows and spelled out in 0194: there is no account behind it to protect.
       */
      const s = await q.query(
        `select name, sum(trades)::int as trades, sum(winnings_cents)::bigint as amount_cents
           from public.leaderboard_seed
          where site_id = $1 and created_at <= now()
            and ${leaderboardWindowSql(period, 'created_at')}
          group by name
         having sum(winnings_cents) > 0
          order by sum(winnings_cents) desc
          limit $2`,
        [siteId, limit],
      );
      const seeded: LeaderboardRow[] = s.rows.map((x) => ({
        rank: 0,
        name: String(x.name ?? '').trim() || 'A trader',
        trades: Math.max(0, Math.round(Number(x.trades ?? 0))),
        profitCents: Math.max(0, Math.round(Number(x.amount_cents ?? 0))),
        seeded: true,
      }));

      // The same merge rule as the feed: every real trader who qualified keeps a place on the board
      // however large the seeded numbers beside them are, and the seeded rows fill what is left.
      // The rows that ARE shown are then ordered by the ranked amount, descending, so the board is
      // never out of order with the number printed on it.
      return rank(mergeByMeritWithRealFloor(real, seeded, limit, (x) => -x.profitCents));
    },
  };
}

/** Number the board 1..n in the order it is already in. */
function rank(rows: LeaderboardRow[]): LeaderboardRow[] {
  return rows.map((x, i) => ({ ...x, rank: i + 1 }));
}
