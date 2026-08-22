/**
 * Scheduled DAILY dynamic pool distribution (#5 autonomy) — runs the demand-based allocator so each
 * brand's withdrawal-pool cap tracks demand with NO superadmin. Reuses the SAME engine path as the
 * console (PlatformService.distributePoolDynamic -> audited fn_platform_distribute_pool per_site).
 *
 * GUARDED + opt-in:
 *   - Does NOTHING unless POOL_DAILY_TOTAL_CENTS (the global envelope, integer cents) is set > 0.
 *     So the schedule stays inert until the operator deliberately configures the envelope — it can
 *     never spend money that wasn't explicitly allocated.
 *   - --dry-run computes + prints the allocation WITHOUT applying.
 *   - Fully audited (platform_pool_distributions + admin_actions), Σ alloc <= envelope by construction.
 *
 * Run: DATABASE_URL=... POOL_DAILY_TOTAL_CENTS=... node --import tsx scripts/pool_distribute_daily.mts [--dry-run] [--lookback 14]
 */
import { Pool } from "pg";
import { PgPlatformRepository, PlatformService } from "@invest254/engine";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
const DRY = process.argv.includes("--dry-run");
const LOOKBACK = Number(arg("lookback", "14"));

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

const total = Number(process.env.POOL_DAILY_TOTAL_CENTS ?? "0");
if (!Number.isFinite(total) || total <= 0) {
  // Guard: inert until the operator configures the envelope. Not an error — a clean no-op.
  console.log("[pool-distribute] POOL_DAILY_TOTAL_CENTS unset/<=0 — skipping (schedule is inert until configured).");
  process.exit(0);
}

const money = (c: number) => `KES ${(c / 100).toLocaleString()}`;

async function main() {
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const repo = new PgPlatformRepository({
      query: (sql: string, params?: unknown[]) => pool.query(sql, (params ?? []) as unknown[]),
    });
    const svc = new PlatformService(repo);

    if (DRY) {
      const preview = await svc.poolDemand({ totalCents: total, lookbackDays: LOOKBACK });
      console.log(`[pool-distribute] DRY-RUN envelope=${money(total)} lookback=${LOOKBACK}d`);
      for (const r of preview.rows) {
        console.log(`  ${r.slug.padEnd(14)} forecast/day=${money(r.forecastTurnoverCents).padEnd(14)} required=${money(r.requiredCents).padEnd(14)} suggested=${money(r.suggestedCents)}`);
      }
      console.log(`  suggested total=${money(preview.suggestedTotalCents)} reserve=${money(preview.reserveCents)}`);
      return;
    }

    const actor = (await pool.query("select id from profiles where role='platform_superadmin' order by created_at limit 1")).rows[0]?.id as string | undefined;
    if (!actor) { console.error("[pool-distribute] no platform_superadmin actor found — cannot audit; aborting."); process.exit(3); }

    const res = await svc.distributePoolDynamic(actor, "platform_superadmin", { totalCents: total, lookbackDays: LOOKBACK });
    console.log(`[pool-distribute] applied envelope=${money(total)} lookback=${LOOKBACK}d — per-brand caps:`);
    for (const r of res.preview.rows) {
      console.log(`  ${r.slug.padEnd(14)} demand/day=${money(r.forecastTurnoverCents).padEnd(14)} -> cap=${money(r.suggestedCents)}`);
    }
    console.log(`  distributed total=${money(res.preview.suggestedTotalCents)} reserve=${money(res.preview.reserveCents)} (mode=${res.mode})`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("[pool-distribute] FAILED:", e); process.exit(1); });
