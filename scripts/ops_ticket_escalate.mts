/**
 * ops_ticket_escalate.mts — auto-escalate overdue tickets (Issue 2).
 * Calls fn_ticket_auto_escalate(): any OPEN/IN_PROGRESS level-0 ticket past its urgency SLA is
 * escalated to the System admin, logged in ticket_escalations, and the System admin is notified.
 * Idempotent (only overdue level-0 tickets move). Env: DATABASE_URL (Supabase session pooler).
 * Run: DATABASE_URL=... node --import tsx scripts/ops_ticket_escalate.mts
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const pool = new Pool({ connectionString: url, max: 2 });
try {
  const r = await pool.query("select public.fn_ticket_auto_escalate() as n");
  console.log(`ticket auto-escalate: ${r.rows[0].n} ticket(s) escalated to the System admin`);
} catch (e) {
  console.error("ticket auto-escalate failed:", (e as Error).message); process.exitCode = 1;
} finally { await pool.end(); }
