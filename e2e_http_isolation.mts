/**
 * FULL-STACK HTTP site-isolation e2e. Boots the real API (createApp) with Pg-backed admin +
 * marketer repos against a seeded two-brand Postgres, then makes real HTTP requests carrying a
 * brand-scoped admin JWT (`<uid>:admin:<siteId>`) and asserts the RESPONSE body is scoped to that
 * brand — proving the whole chain: HTTP → auth (site claim) → ctx.siteId → repo → SQL.
 *
 * Run: DBU=postgres://... node --import tsx e2e_http_isolation.mts
 */
import pg from "pg";
import { PgAdminRepository } from "@invest254/engine";
import { makePgMarketerRepo } from "./apps/api/src/marketers.pg.ts";
import { startTestApi } from "./apps/api/src/testutil.ts";

const pool = new pg.Pool({ connectionString: process.env.DBU! });
const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
const A = "00000000-0000-0000-0000-000000000001";
const HASH = "scrypt$32768$8$1$" + "a".repeat(24) + "$" + "b".repeat(24);
let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, m: string) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (ok) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}\n       got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); } };

async function reg(site: string, phone: string, user: string): Promise<string> {
  const r = await q("select user_id from fn_register_user($1,$2,$3,$4,$5::uuid)", [phone, user, HASH, null, site]);
  return String(r.rows[0].user_id);
}
async function dep(site: string, uid: string, amt: number, phone: string) {
  await q("insert into transactions(user_id, site_id, kind, amount, status, phone) values ($1,$2,'deposit',$3,'success',$4)", [uid, site, amt, phone]);
}

async function main() {
  // ── seed two brands ──
  const B = String((await q("select fn_platform_create_site($1,'platform_superadmin','madolar','Madolar','KES','madolar.com') as id", [A])).rows[0].id);
  const a1 = await reg(A, "254700000001", "a_alice"); await dep(A, a1, 300000, "254700000001");
  const a2 = await reg(A, "254700000002", "a_bob");   await dep(A, a2, 200000, "254700000002"); // A deposits 500000
  const b1 = await reg(B, "254711000001", "b_dan");   await dep(B, b1, 170000, "254711000001"); // B deposits 170000
  const mrepo = makePgMarketerRepo((sql, p) => pool.query(sql, p ?? []));
  await mrepo.create("Alice Njeri", "0790000001", A);
  await mrepo.create("Bob Otieno", "0790000002", A);
  await mrepo.create("Alice Madolar", "0790000001", B); // same phone, different brand

  // ── boot the REAL API with Pg-backed admin + marketer deps ──
  const api = await startTestApi({ depsOverrides: {
    admin: new PgAdminRepository(pool as any) as any,
    marketers: mrepo,
  } } as any);
  const get = async (path: string, token: string) => {
    const res = await fetch(`${api.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: res.status < 400 ? await res.json() as any : null };
  };
  const TA = `adm:admin:${A}`, TB = `adm:admin:${B}`, TG = `adm:admin`; // A-admin, B-admin, platform (no site)

  try {
    console.log("\n── GET /admin/overview via real HTTP with brand-scoped tokens ──");
    eq((await get("/api/v1/admin/overview", TA)).body.finance.depositsCents, 500000, "A-admin overview -> A deposits");
    eq((await get("/api/v1/admin/overview", TB)).body.finance.depositsCents, 170000, "B-admin overview -> B deposits (NOT invest254's)");
    eq((await get("/api/v1/admin/overview", TG)).body.finance.depositsCents, 670000, "platform-admin overview -> GLOBAL sum");

    console.log("\n── GET /admin/reports/day ──");
    const today = new Date().toISOString().slice(0, 10);
    eq((await get(`/api/v1/admin/reports/day?date=${today}`, TB)).body.deposits.amountCents, 170000, "B-admin day report -> B deposits");

    console.log("\n── GET /admin/marketers (the reported leak, over HTTP) ──");
    eq((await get("/api/v1/admin/marketers", TA)).body.length ?? (await get("/api/v1/admin/marketers", TA)).body?.items?.length, 2, "A-admin marketers -> 2");
    const mB = (await get("/api/v1/admin/marketers", TB)).body;
    const mBlen = Array.isArray(mB) ? mB.length : mB.items?.length;
    eq(mBlen, 1, "B-admin marketers -> 1 (only madolar's)");

    console.log("\n── GET /admin/users scoping ──");
    const uA = (await get("/api/v1/admin/users", TA)).body.items.map((u: any) => u.username).sort();
    const uB = (await get("/api/v1/admin/users", TB)).body.items.map((u: any) => u.username).sort();
    eq(uA, ["a_alice", "a_bob"], "A-admin users -> only A");
    eq(uB, ["b_dan"], "B-admin users -> only B");

    console.log("\n── IDOR over HTTP: A-admin reading a B user by id -> 403 ──");
    eq((await get(`/api/v1/admin/users/${b1}`, TA)).status, 403, "A-admin GET B-user detail -> 403 SITE_SCOPE_FORBIDDEN");
    eq((await get(`/api/v1/admin/users/${a1}`, TA)).status, 200, "A-admin GET own A-user detail -> 200");
    eq((await get(`/api/v1/admin/users/${a1}/notifications`, TB)).status, 403, "B-admin GET A-user notifications -> 403");

    console.log(`\n==== HTTP e2e result: ${pass} passed, ${fail} failed ====`);
  } finally { await api.close(); await pool.end(); }
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
