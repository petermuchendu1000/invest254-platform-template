/**
 * verify_platform_cleanliness.ts — reproducible data-cleanliness reconciliation (docs/24).
 *
 * Asserts that the platform console's `fn_platform_overview` reports REAL-PLAYER figures only, i.e.
 * it excludes the internal marketer funny-money cohort (`marketer_account_ids`, migration 0070) and
 * internal (`provider='internal'`) withdrawals — the exact same clean definition the per-brand
 * finance page uses. For every site it recomputes the clean formula directly and compares.
 *
 * Run:  DATABASE_URL=postgres://... npx tsx scripts/verify_platform_cleanliness.ts
 * Exit: 0 if every site reconciles; 1 (with a diff) otherwise. Read-only.
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

const pool = new Pool({ connectionString: url });

async function main(): Promise<void> {
  const ov = await pool.query(
    "select site_id, slug, users, deposits_cents, withdrawals_cents, ggr_cents, bets from fn_platform_overview('platform_superadmin')",
  );
  let allOk = true;
  for (const r of ov.rows) {
    const c = await pool.query(
      `select
        (select count(*) from profiles where site_id=$1 and id not in (select user_id from marketer_account_ids)) as users,
        (select coalesce(sum(amount),0) from transactions where site_id=$1 and kind='deposit' and status='success' and user_id not in (select user_id from marketer_account_ids)) as dep,
        (select coalesce(sum(amount),0) from transactions where site_id=$1 and kind='withdrawal' and status='success' and provider is distinct from 'internal' and user_id not in (select user_id from marketer_account_ids)) as wd,
        (select coalesce(sum(stake-payout),0) from positions where site_id=$1 and status='settled' and user_id not in (select user_id from marketer_account_ids)) as ggr,
        (select count(*) from positions where site_id=$1 and status='settled' and user_id not in (select user_id from marketer_account_ids)) as bets`,
      [r.site_id],
    );
    const x = c.rows[0];
    const ok = String(r.users) === String(x.users) && String(r.deposits_cents) === String(x.dep)
      && String(r.withdrawals_cents) === String(x.wd) && String(r.ggr_cents) === String(x.ggr)
      && String(r.bets) === String(x.bets);
    allOk = allOk && ok;
    console.log(`${ok ? "✅" : "❌"} ${r.slug}: overview(users=${r.users},dep=${r.deposits_cents},wd=${r.withdrawals_cents},ggr=${r.ggr_cents},bets=${r.bets})`
      + (ok ? "" : `  clean(users=${x.users},dep=${x.dep},wd=${x.wd},ggr=${x.ggr},bets=${x.bets})`));
  }
  await pool.end();
  console.log(allOk ? "\nALL SITES CLEAN & RECONCILED" : "\nDATA CLEANLINESS FAILED");
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
