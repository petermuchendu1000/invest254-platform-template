/**
 * poolhealth.ts — the withdrawal-pool starvation monitor (docs/25 §15.7, BUGLOG #12/#12b).
 *
 * Why this exists alongside the win-rate monitor: that one only alerts on windows with >= 50
 * samples, but starvation SUPPRESSES volume — players hit 100% losses and leave — so a starved
 * brand often never reaches 50 trades and the drift alert stays silent. This looks instead at the
 * STRUCTURAL signal (available budget against stake) and at live all-loss streaks, so it fires
 * early on exactly the brands the other monitor cannot see.
 *
 * Ported from `scripts/pool_health_monitor.py`, which ran on a half-hourly GitHub Actions cron. GitHub
 * de-prioritises high-frequency schedules: measured over 24h on 2026-10-22 it fired 6 times out of
 * 48, at gaps of 3h14m to 5h15m. A safety net for a money failure cannot run when the scheduler
 * feels like it, so the timer moved into the API process (BUGLOG #160) where the other sweeps live.
 * The CLI and the workflow still exist as the manual lever and call straight into this module, so
 * there is ONE implementation of these thresholds rather than two that can drift — the Python copy
 * had already drifted to the extent of hardcoding `PLAYER_SHARE = 0.15` beside the real knob.
 *
 * Read-only. No writes, no schema.
 */
import { DEFAULT_POOL_KNOBS } from "@invest254/shared";

export type Querier = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/** Decided trades today before a win-less day is an ALERT rather than noise (the cron's default). */
export const DEFAULT_MIN_DECISIONS = 8;

/**
 * The rolling window the alerts are judged on — deliberately NOT the whole EAT day, so a brand that
 * has just been re-funded clears immediately instead of being flagged for stale pre-remediation
 * losses, while a genuine live all-loss streak still pages. A literal, never interpolated.
 */
export const POOL_HEALTH_WINDOW_SQL = "interval '2 hours'";

/**
 * `bigint` and `numeric` reach node-postgres as STRINGS, and this module compares them with `<`.
 * Left as strings, `"9000" < "25000"` is lexicographically TRUE and numerically FALSE, which would
 * silently invert a starvation test. The repo's convention is a local coercion at the row boundary
 * (`toCents` in wallet.ts / payments.ts / demo.pg.ts); this is the same thing, named for what it
 * guards.
 */
const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The smallest pool that can actually pay a maximum win: one minimum stake at the maximum
 * multiplier, grossed up by the per-player share cap, because no single player may win more than
 * `playerShare` of the day's pool (pool.ts). `playerShare` is IMPORTED rather than restated — the
 * Python original carried its own 0.15 and nothing would have noticed the two parting company.
 *
 * Rounds UP. This is the ONE place the port deliberately differs from the Python original, so it is
 * worth being exact about: the original wrote the ceiling as `-(-x // PLAYER_SHARE)`, and CPython's
 * float floor-division is fmod-corrected — it sees the TRUE quotient of the doubles rather than the
 * rounded one. 0.15 as a double is a shade under 0.15, so 15/0.15 is exactly 100.0 when rounded but
 * 100.0000000000000037 exactly, and the original therefore returned 101 where this returns 100.
 * (Python's own `math.ceil(x/0.15)` also returns 100, so the original disagreed with itself.)
 *
 * `Math.ceil` is kept because the intent is the decimal 0.15, not its binary neighbour. The gap is
 * at most ONE CENT, only when the division comes out exact, and only on BELOW_VIABLE — a warning
 * that never pages. Recorded so nobody "corrects" it in either direction by accident.
 */
export function minViableCents(minStakeCents: number, maxMultiplier: number): number {
  if (!minStakeCents) return 0;
  return Math.ceil((minStakeCents * maxMultiplier) / DEFAULT_POOL_KNOBS.playerShare);
}

export type PoolAlertKind = "POOL_STARVED" | "ALL_LOSS" | "BELOW_VIABLE";

export interface PoolAlert {
  kind: PoolAlertKind;
  /** Operator-facing text, byte-identical to the Python original so alert history stays greppable. */
  text: string;
}

export interface BrandHealth {
  slug: string;
  amountCents: number;
  availableCents: number;
  minStakeCents: number;
  minViableCents: number;
  decisions: number;
  wins: number;
  turnoverCents: number;
  alerts: PoolAlert[];
}

/** One row per ACTIVE pool-mode brand: live pool state plus the rolling decision window. */
export const POOL_HEALTH_SQL = `
  with day as (select (now() at time zone 'Africa/Nairobi')::date as d)
  select s.slug,
         coalesce(g.min_stake, 0)                                  as min_stake,
         greatest(coalesce(g.max_multiplier, 1), 1)                as max_mult,
         coalesce(wp.amount_cents, 0)                              as amount,
         coalesce(wp.paid_cents, 0)                                as paid,
         coalesce(wp.reserved_cents, 0)                            as reserved,
         coalesce(dd.decisions, 0)                                 as decisions,
         coalesce(dd.wins, 0)                                      as wins,
         coalesce(dd.turnover, 0)                                  as turnover
    from sites s
    left join site_game_config g on g.site_id = s.id
    cross join day
    left join withdrawal_pool wp on wp.site_id = s.id and wp.trade_day = day.d
    left join (
        select d2.site_id,
               count(*)                                        as decisions,
               count(*) filter (where d2.decided_result='win')  as wins,
               coalesce(sum(p.stake), 0)                        as turnover
          from position_decision d2
          join positions p on p.id = d2.position_id
         where p.opened_at >= now() - ${POOL_HEALTH_WINDOW_SQL}
         group by d2.site_id
    ) dd on dd.site_id = s.id
   where s.status = 'active' and s.pool_mode = true
   order by s.created_at`;

/**
 * The thresholds, kept pure so they are testable without a database — which matters because the
 * database-backed tests are gated on a DATABASE_URL that CI does not have.
 *
 * Order is load-bearing: BELOW_VIABLE is a WARNING and only reported when nothing worse applies,
 * so a starved brand pages about starvation rather than about being under-funded.
 */
export function evaluateBrand(row: Record<string, unknown>, minDecisions = DEFAULT_MIN_DECISIONS): BrandHealth {
  const slug = String(row.slug ?? "");
  const minStakeCents = num(row.min_stake);
  const maxMult = num(row.max_mult);
  const amountCents = num(row.amount);
  const availableCents = Math.max(0, amountCents - num(row.paid) - num(row.reserved));
  const decisions = num(row.decisions);
  const wins = num(row.wins);
  const turnoverCents = num(row.turnover);
  const viable = minViableCents(minStakeCents, maxMult);
  const alerts: PoolAlert[] = [];

  // The pool cannot fund a single minimum win, and trades are happening into it: every one of them
  // is a guaranteed loss.
  if (decisions > 0 && availableCents < minStakeCents) {
    alerts.push({
      kind: "POOL_STARVED",
      text: `POOL_STARVED available=${availableCents} < min_stake=${minStakeCents} `
        + `(cannot fund a single win; ${decisions} trades in last 2h)`,
    });
  }
  // Enough live decisions to be a signal rather than a coincidence, and not one of them won.
  if (turnoverCents > 0 && decisions >= minDecisions && wins === 0) {
    alerts.push({
      kind: "ALL_LOSS",
      text: `ALL_LOSS ${decisions} trades, 0 wins in last 2h (turnover=${turnoverCents})`,
    });
  }
  // Wins are possible but throttled — worth topping up, not worth waking anyone.
  if (turnoverCents > 0 && availableCents < viable && alerts.length === 0) {
    alerts.push({
      kind: "BELOW_VIABLE",
      text: `BELOW_VIABLE available=${availableCents} < min_viable=${viable} (warning)`,
    });
  }
  return { slug, amountCents, availableCents, minStakeCents, minViableCents: viable, decisions, wins, turnoverCents, alerts };
}

export interface PoolHealthReport {
  brands: BrandHealth[];
  /** POOL_STARVED / ALL_LOSS — someone is losing money now. Pages, and fails the CLI. */
  hard: string[];
  /** BELOW_VIABLE — report it, do not wake anyone. */
  warnings: string[];
  alert: boolean;
}

export function summarise(brands: BrandHealth[]): PoolHealthReport {
  const hard: string[] = [];
  const warnings: string[] = [];
  for (const b of brands) {
    for (const a of b.alerts) (a.kind === "BELOW_VIABLE" ? warnings : hard).push(`${b.slug}: ${a.text}`);
  }
  return { brands, hard, warnings, alert: hard.length > 0 };
}

/** The page itself, wording unchanged from the cron so an operator sees what they always have. */
export function buildStarvationAlert(hard: string[]): string {
  return "🚨 <b>Invest254 pool starvation</b>\n" + hard.join("\n")
    + "\n\nPlayers may be losing 100%. Re-fund the pool / run a dynamic distribution.";
}

export async function checkPoolHealth(
  q: Querier,
  opts: { minDecisions?: number } = {},
): Promise<PoolHealthReport> {
  const minDecisions = opts.minDecisions ?? DEFAULT_MIN_DECISIONS;
  const { rows } = await q.query(POOL_HEALTH_SQL, []);
  return summarise(rows.map((r) => evaluateBrand(r, minDecisions)));
}
