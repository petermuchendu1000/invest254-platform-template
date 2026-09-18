/**
 * ops_subscription_advance.mts — advance subscription lifecycle (Issue 2).
 * Calls fn_subscription_auto_advance(): Trial->Past Due (unpaid trial end), Active->Past Due
 * (past due date), Past Due->Grace, Grace->Suspended, using ops_config durations. Idempotent.
 * Env: DATABASE_URL (Supabase session pooler).
 * Run: DATABASE_URL=... node --import tsx scripts/ops_subscription_advance.mts
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const pool = new Pool({ connectionString: url, max: 2 });
try {
  const r = await pool.query("select public.fn_subscription_auto_advance() as n");
  console.log(`subscription auto-advance: ${r.rows[0].n} subscription(s) transitioned`);
} catch (e) {
  console.error("subscription auto-advance failed:", (e as Error).message); process.exitCode = 1;
} finally { await pool.end(); }
