/**
 * Nightly provable-fairness reproducibility guard (docs/28 §4; audit rec #6).
 *
 * For a sample of recent SETTLED, statistically-priced positions (NOT pool-decided, NOT marketer, NOT
 * overridden, on a REVEALED-seed day with a resolvable config_version), recompute the outcome from
 * (revealed seed, config_version, entryT, nonce) using the SAME production code path
 * (CurveGenerator + SettlementEngine.settleVariable) and assert it equals the RECORDED result +
 * multiplier. A drift here means the stored outcome is not reproducible from its published inputs —
 * i.e. a provable-fairness / settlement-integrity break.
 *
 * Writes one audit row to public.reproducibility_check_runs (migration 0090) and exits non-zero when
 * the match rate falls below MATCH_THRESHOLD, so a scheduler (GitHub Action / fly machine / cron) can
 * alert. Read-only against game data; only inserts into the audit table.
 *
 * Run:  DATABASE_URL=... node --import tsx scripts/reproducibility_check.mts [--limit 500] [--days 2] [--site <uuid>]
 */
import { Pool } from "pg";
import { CurveGenerator, SettlementEngine, dayStartMs, dateKeyUTC, type GameConfig } from "@invest254/shared";

const CAL_SAMPLES = 200_000;   // MUST match the engine's production calibration (SeedManager default)
const MATCH_THRESHOLD = 0.98;  // alert if fewer than 98% of the clean sample reproduce exactly
const MULT_TOL = 1e-4;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
const LIMIT = Number(arg("limit", "500"));
const DAYS = Number(arg("days", "2"));
const SITE = arg("site", "");

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

type Row = {
  id: string; direction: "buy" | "sell"; stake: string; result: string; multiplier: string | null;
  nonce: string; opened_ms: string; config_version: string; site_id: string; trade_date: string; seed: string;
  house_edge: string; max_multiplier: string; min_stake: string; max_stake: string; min_withdrawal: string;
  default_duration_s: number; tick_rate_ms: number; drift_bias: string; volatility: string; target_win_rate: string;
};
const cfgOf = (r: Row): GameConfig & { version: number } => ({
  houseEdge: Number(r.house_edge), maxMultiplier: Number(r.max_multiplier),
  minStakeCents: Number(r.min_stake), maxStakeCents: Number(r.max_stake), minWithdrawalCents: Number(r.min_withdrawal),
  defaultDurationS: Number(r.default_duration_s), tickRateMs: Number(r.tick_rate_ms),
  driftBias: Number(r.drift_bias), volatility: Number(r.volatility), targetWinRate: Number(r.target_win_rate),
  version: Number(r.config_version),
});
const near = (a: number, b: number) => Math.abs(a - b) <= MULT_TOL * Math.max(1, Math.abs(a), Math.abs(b));

async function main() {
  const pool = new Pool({ connectionString: url, max: 3 });
  const engineCache = new Map<string, SettlementEngine>();
  const engineFor = (seed: string, cfg: GameConfig & { version: number }): SettlementEngine => {
    const k = `${seed}#${cfg.version}`; let e = engineCache.get(k);
    if (!e) { e = new SettlementEngine(new CurveGenerator(seed, cfg), cfg, "calibration", cfg.defaultDurationS, 3600, CAL_SAMPLES); engineCache.set(k, e); }
    return e;
  };
  try {
    const { rows } = await pool.query<Row>(
      `select p.id, p.direction, p.stake, p.result, p.multiplier, p.nonce,
              extract(epoch from p.opened_at)*1000 as opened_ms, p.config_version, p.site_id::text as site_id,
              gd.trade_date::text as trade_date, gd.server_seed as seed,
              v.house_edge, v.max_multiplier, v.min_stake, v.max_stake, v.min_withdrawal,
              v.default_duration_s, v.tick_rate_ms, v.drift_bias, v.volatility, v.target_win_rate
         from positions p
         join game_days gd on gd.id = p.game_day_id and gd.server_seed is not null
         join site_game_config_versions v on v.site_id = p.site_id and v.version = p.config_version
        where p.status = 'settled'
          and p.opened_at > now() - ($1 || ' days')::interval
          and ($2::uuid is null or p.site_id = $2)
          and not exists (select 1 from position_decision d where d.position_id = p.id)   -- exclude pool-decided
          and p.user_id not in (select user_id from marketer_account_ids)                 -- exclude demo cohort
          and p.user_id not in (select user_id from user_overrides)                       -- exclude per-user pricing
        order by p.opened_at desc
        limit $3`,
      [String(DAYS), SITE || null, LIMIT]);

    let matched = 0; const mism: any[] = [];
    for (const r of rows) {
      const cfg = cfgOf(r);
      const eng = engineFor(r.seed, cfg);
      const entryT = (Number(r.opened_ms) - dayStartMs(r.trade_date)) / 1000;
      const o = eng.settleVariable(Number(r.stake), r.direction, entryT, Number(r.nonce), r.seed);
      const recMult = r.multiplier == null ? 0 : Number(r.multiplier);
      const ok = o.result === r.result && (r.result !== "win" || near(o.multiplier, recMult));
      if (ok) matched++;
      else if (mism.length < 25) mism.push({ id: r.id, recorded: { result: r.result, multiplier: recMult }, recomputed: { result: o.result, multiplier: Number(o.multiplier.toFixed(6)) }, cfg_v: cfg.version, trade_date: r.trade_date });
      // sanity: dateKeyUTC(opened) should equal trade_date; note if not (EAT/UTC boundary)
      if (dateKeyUTC(Number(r.opened_ms)) !== r.trade_date && mism.length < 25) { /* boundary case, still compared */ }
    }
    const sampled = rows.length;
    const mismatched = sampled - matched;
    const pct = sampled > 0 ? Number((mismatched / sampled).toFixed(4)) : 0;
    const okRun = sampled === 0 ? true : (matched / sampled) >= MATCH_THRESHOLD;
    await pool.query(
      `insert into reproducibility_check_runs(site_id, window_desc, sampled, matched, mismatched, mismatch_pct, ok, details, notes)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [SITE || null, `last ${DAYS}d, clean cohort`, sampled, matched, mismatched, pct, okRun,
       JSON.stringify({ mismatches: mism, calSamples: CAL_SAMPLES, threshold: MATCH_THRESHOLD }),
       sampled === 0 ? "no clean samples in window" : `match ${(matched / sampled * 100).toFixed(2)}%`]);

    console.log(`reproducibility: sampled=${sampled} matched=${matched} mismatched=${mismatched} (${(pct * 100).toFixed(2)}%) ok=${okRun}`);
    if (mism.length) console.log("first mismatches:", JSON.stringify(mism.slice(0, 5), null, 2));
    process.exitCode = okRun ? 0 : 1;
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error("reproducibility check failed:", e); process.exit(2); });
