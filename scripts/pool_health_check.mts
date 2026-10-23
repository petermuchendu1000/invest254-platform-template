/**
 * pool_health_check.mts — the MANUAL lever for the withdrawal-pool starvation monitor
 * (docs/25 §15.7, BUGLOG #12/#12b, #160).
 *
 * The monitor itself runs inside the API process now (apps/api/src/server.ts,
 * POOL_HEALTH_INTERVAL_MS), because the half-hourly GitHub cron it used to live on fired six times
 * in 24 hours instead of 48. This exists for the times the timer is not the answer: the API is
 * down, mid-rollback, or somebody wants an answer now without waiting for the next tick.
 *
 * It calls straight into apps/api/src/poolhealth.ts, so there is exactly ONE implementation of
 * these thresholds. The Python script this replaces was a second one, and it had already drifted —
 * it carried its own `PLAYER_SHARE = 0.15` beside the real knob in pool.ts.
 *
 * Contract kept identical to that script, so the workflow and anyone's muscle memory still work:
 *   DATABASE_URL=postgres://... node --import tsx scripts/pool_health_check.mts [--min-decisions 8] [--json]
 * Exit 0 healthy, 1 on a hard alert (POOL_STARVED / ALL_LOSS), 2 on a configuration error.
 */
import { Pool } from "pg";
import {
  DEFAULT_MIN_DECISIONS, buildStarvationAlert, checkPoolHealth,
} from "../apps/api/src/poolhealth.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");
const minDecisions = Number(flag("--min-decisions") ?? DEFAULT_MIN_DECISIONS);

const url = process.env.DATABASE_URL;
if (!url) { console.error("ERROR: DATABASE_URL not set"); process.exit(2); }
if (!Number.isFinite(minDecisions) || minDecisions < 0) {
  console.error("ERROR: --min-decisions must be a non-negative number"); process.exit(2);
}

/** Direct HTTPS, as the Python did: the CLI must not need the API's Telegram client to page. */
async function sendTelegram(text: string): Promise<void> {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatIds = (process.env.TELEGRAM_CHAT_IDS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) return;
  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) console.error(`[warn] telegram send failed for chat ${chatId}: HTTP ${res.status}`);
    } catch (e) {
      // Never let an alerting failure mask the exit code — the exit code is what the caller acts on.
      console.error(`[warn] telegram send failed for chat ${chatId}: ${(e as Error).message}`);
    }
  }
}

const pool = new Pool({ connectionString: url, max: 2 });
try {
  const r = await checkPoolHealth(pool, { minDecisions });
  if (asJson) {
    console.log(JSON.stringify({
      alert: r.alert,
      warnings: r.warnings,
      brands: r.brands.map((b) => ({
        slug: b.slug, amount: b.amountCents, available: b.availableCents, min_stake: b.minStakeCents,
        min_viable: b.minViableCents, decisions: b.decisions, wins: b.wins, turnover: b.turnoverCents,
        alerts: b.alerts.map((a) => a.text),
      })),
    }, null, 2));
  } else {
    for (const b of r.brands) {
      const hard = b.alerts.some((a) => a.kind !== "BELOW_VIABLE");
      const flagIcon = hard ? "🚨" : b.alerts.length > 0 ? "⚠️" : "✅";
      console.log(
        `${flagIcon} ${b.slug.padEnd(13)} avail=${String(b.availableCents).padStart(10)} `
        + `min_stake=${String(b.minStakeCents).padStart(7)} decisions=${String(b.decisions).padStart(4)} `
        + `wins=${String(b.wins).padStart(4)} turnover=${String(b.turnoverCents).padStart(10)}`);
      for (const a of b.alerts) console.log(`      - ${a.text}`);
    }
    console.log(`\nOVERALL: ${r.alert ? "🚨 ALERT" : "✅ healthy"}`);
  }
  if (r.alert) {
    await sendTelegram(buildStarvationAlert(r.hard));
    process.exitCode = 1;
  }
} catch (e) {
  console.error("pool-health check failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
