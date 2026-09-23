/**
 * Scheduled DAILY automatic pool distribution (POOL-1, docs/46; docs/25 §15). For EVERY platform with an active
 * brand, applies that platform's automatic distribution setting (pool_auto_settings, migration 0164):
 *   - dynamic (THE DEFAULT when nothing is saved): demand-based water-fill over the platform's configured daily
 *     total, or — when none is set — its CURRENT total (the sum of its brands' daily defaults). So the default
 *     never budgets more money than the operator already set; it only moves it to where the demand is.
 *   - equal: even split of the configured daily total.  - off: nothing.
 * Every run is audited (platform_pool_distributions source='auto' + admin_actions) and its outcome recorded on
 * the platform's settings, shown on /platform/pool.
 *
 * --dry-run prints each platform's setting and demand preview without applying.
 * Optional POOL_MIN_FLOOR_CENTS: absolute anti-starvation floor per brand (docs/25 §15.6).
 *
 * Run: DATABASE_URL=... node --import tsx scripts/pool_distribute_daily.mts [--dry-run]
 */
import { Pool } from "pg";
import { PgPlatformRepository, PlatformService, PgPoolOpsRepository, PoolOpsService } from "@invest254/engine";

const DRY = process.argv.includes("--dry-run");
const MIN_FLOOR = Math.max(0, Math.floor(Number(process.env.POOL_MIN_FLOOR_CENTS ?? "0")) || 0);
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const money = (c: number) => `KES ${Math.round(c / 100).toLocaleString("en-KE")}`;

async function main() {
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const q = { query: (sql: string, params?: unknown[]) => pool.query(sql, (params ?? []) as unknown[]) };
    const platform = new PlatformService(new PgPlatformRepository(q));
    const ops = new PoolOpsService(new PgPoolOpsRepository(q), platform);
    const actor = (await pool.query("select id from profiles where role='platform_superadmin' order by created_at limit 1")).rows[0]?.id as string | undefined;
    if (!actor) { console.error("[pool-auto] no platform_superadmin actor found — cannot audit; aborting."); process.exit(3); }
    const platforms = await ops.activePlatforms();
    console.log(`[pool-auto] ${platforms.length} platform(s) with active brands${DRY ? " (dry run)" : ""}`);
    let failed = 0;
    for (const p of platforms) {
      const s = await ops.settings(actor, "platform_superadmin", p);
      if (DRY) {
        const prev = s.mode === "dynamic"
          ? await platform.poolDemand({ lookbackDays: s.lookbackDays, ...(s.dailyTotalCents != null ? { totalCents: s.dailyTotalCents } : {}), configuredFloorCents: MIN_FLOOR }, p)
          : null;
        console.log(`  ${p} mode=${s.mode}${s.isDefault ? " (default)" : ""} total=${s.dailyTotalCents == null ? "current" : money(s.dailyTotalCents)}` +
          (prev ? ` -> ${prev.rows.map((r) => `${r.slug}=${money(r.suggestedCents)}`).join(", ")}` : ""));
        continue;
      }
      const r = await ops.runAuto(actor, "platform_superadmin", p, "auto", { configuredFloorCents: MIN_FLOOR });
      if (!r.ok) failed++;
      console.log(`  ${p} mode=${r.mode} ${r.ok ? "ok" : "FAILED"}: ${r.message}`);
    }
    if (failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("[pool-auto] FAILED:", e); process.exit(1); });
