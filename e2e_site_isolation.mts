/**
 * INTENSIVE multi-tenant SITE-ISOLATION e2e (Fix A + Fix B).
 *
 * Drives the REAL production code — PgAdminRepository (engine), makePgMarketerRepo (api) and
 * assertTargetSiteInScope (api http) — against a real Postgres seeded with TWO brands carrying
 * DISTINCT, realistic data. Proves every admin/marketer READ returns only the caller's brand,
 * and that a platform admin (no site) still sees the correct GLOBAL aggregate.
 *
 * Run: DBU=postgres://... node --import tsx e2e_site_isolation.mts
 */
import pg from "pg";
import { PgAdminRepository } from "@invest254/engine";
import { makePgMarketerRepo } from "./apps/api/src/marketers.pg.ts";
import { assertTargetSiteInScope } from "./apps/api/src/http.ts";

const DBU = process.env.DBU!;
const pool = new pg.Pool({ connectionString: DBU });
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

const A = "00000000-0000-0000-0000-000000000001"; // default site (invest254)
let B = "";                                        // madolar (created below)
const TODAY = new Date().toISOString().slice(0, 10); // UTC date; created_at defaults to now() (UTC)
const HASH = "scrypt$32768$8$1$" + "a".repeat(24) + "$" + "b".repeat(24);

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, msg: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};
const ok = (cond: boolean, msg: string) => eq(!!cond, true, msg);

async function reg(site: string, phone: string, user: string): Promise<string> {
  const r = await q("select user_id from fn_register_user($1,$2,$3,$4,$5::uuid)", [phone, user, HASH, null, site]);
  return String(r.rows[0].user_id);
}
async function setBal(uid: string, real: number) { await q("update wallets set real_balance=$2 where user_id=$1", [uid, real]); }
async function tx(site: string, uid: string, kind: string, amount: number, status: string, phone: string) {
  await q("insert into transactions(user_id, site_id, kind, amount, status, phone) values ($1,$2,$3,$4,$5,$6)", [uid, site, kind, amount, status, phone]);
}
async function gameDay(site: string): Promise<number> {
  const r = await q("insert into game_days(trade_date, server_seed_hash, site_id) values ($1,$2,$3) returning id", [TODAY, "hash-" + site.slice(0, 8), site]);
  return Number(r.rows[0].id);
}
async function pos(site: string, uid: string, gd: number, stake: number, payout: number, nonce: number) {
  const result = payout > stake ? "win" : "loss";
  await q(`insert into positions(user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s, status, nonce, opened_at, settled_at, exit_rate, result, multiplier, payout, pnl)
           values ($1,$2,$3,'buy',$4,100,10,'settled',$5, now(), now(), 101, $6, $7, $8, $9)`,
    [uid, site, gd, stake, nonce, result, payout > 0 ? payout / stake : 0, payout, payout - stake]);
}
async function enroll(uid: string): Promise<void> { await q("select * from fn_affiliate_enroll($1)", [uid]); }
async function commission(site: string, aff: string, referred: string, ggr: number, comm: number) {
  await q("insert into affiliate_commissions(affiliate_id, referred_user, period, ggr, commission, status, site_id) values ($1,$2,$3,$4,$5,'accrued',$6)", [aff, referred, TODAY, ggr, comm, site]);
}
async function payout(site: string, aff: string, amount: number) {
  await q("insert into affiliate_payouts(affiliate_id, amount, status, site_id) values ($1,$2,'requested',$3)", [aff, amount, site]);
}
async function audit(site: string, actor: string, action: string) {
  await q("insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id) values ($1,'admin',$2,'x','y','{}'::jsonb,$3)", [actor, action, site]);
}
async function pool_(site: string, amount: number, paid: number) {
  await q("insert into withdrawal_pool(site_id, trade_day, amount_cents, paid_cents, reserved_cents) values ($1,$2,$3,$4,0) on conflict (site_id,trade_day) do update set amount_cents=$3, paid_cents=$4", [site, TODAY, amount, paid]);
}

async function seed() {
  // ── Brand B (madolar) via the real onboarding RPC ──────────────────────────────────────────
  const r = await q("select fn_platform_create_site($1,'platform_superadmin','madolar','Madolar','KES','madolar.com') as id", [A]);
  B = String(r.rows[0].id);

  // ── Brand A: 3 players (p1 enrolled as affiliate), money, affiliate, audit, seeds, pool, marketers ─
  const a1 = await reg(A, "254700000001", "a_alice");
  const a2 = await reg(A, "254700000002", "a_bob");
  const a3 = await reg(A, "254700000003", "a_carol");
  await setBal(a1, 100000); await setBal(a2, 50000); await setBal(a3, 0);      // liability A = 150000
  await tx(A, a1, "deposit", 300000, "success", "254700000001");
  await tx(A, a2, "deposit", 200000, "success", "254700000002");               // A deposits = 500000
  await tx(A, a1, "withdrawal", 120000, "success", "254700000001");            // A withdrawals = 120000
  await tx(A, a2, "withdrawal", 40000, "pending", "254700000002");             // A pending = 1
  const gdA = await gameDay(A);
  await pos(A, a1, gdA, 100000, 150000, 1);                                    // win
  await pos(A, a2, gdA, 100000, 0, 2);                                         // loss  -> turnover 200000, ggr 50000
  await enroll(a1);                                                            // a1 role->marketer, affiliates row (site A)
  await commission(A, a1, a2, 50000, 10000);
  await payout(A, a1, 8000);
  await audit(A, a1, "user.suspend"); await audit(A, a1, "config.update");     // + fn_platform_create_site added an A-site row
  await pool_(A, 500000, 50000);
  const mrepo = makePgMarketerRepo((sql, p) => pool.query(sql, p ?? []));
  const mA1 = await mrepo.create("Alice Njeri", "0790000001", A);
  await mrepo.create("Bob Otieno", "0790000002", A);
  await q("select fn_marketer_set_pin($1,$2)", [mA1.id, "1234"]);

  // ── Brand B: 2 players (p1 affiliate), money, affiliate, audit, seeds, pool, marketer ────────
  const b1 = await reg(B, "254711000001", "b_dan");
  const b2 = await reg(B, "254711000002", "b_eve");
  await setBal(b1, 80000); await setBal(b2, 20000);                            // liability B = 100000
  await tx(B, b1, "deposit", 170000, "success", "254711000001");              // B deposits = 170000
  await tx(B, b1, "withdrawal", 30000, "success", "254711000001");            // B withdrawals = 30000
  const gdB = await gameDay(B);
  await pos(B, b1, gdB, 50000, 0, 1);                                          // loss -> turnover 50000, ggr 50000
  await enroll(b1);
  await commission(B, b1, b2, 50000, 10000);
  await payout(B, b1, 5000);
  await audit(B, b1, "user.ban");
  await pool_(B, 200000, 0);
  const mB1 = await mrepo.create("Alice Madolar", "0790000001", B);           // SAME phone as A's Alice -> per-site identity
  await q("select fn_marketer_set_pin($1,$2)", [mB1.id, "9999"]);
  return { mrepo, mA1, mB1 };
}

async function dbCount(table: string, site: string): Promise<number> {
  const r = await q(`select count(*)::int n from ${table} where site_id = $1`, [site]);
  return Number(r.rows[0].n);
}

async function main() {
  const { mrepo, mA1, mB1 } = await seed();
  const admin = new PgAdminRepository(pool as any);

  console.log("\n── overview (finance summary — the reported leak) ──");
  const ovA = await admin.overview(A), ovB = await admin.overview(B), ovG = await admin.overview();
  eq(ovA.finance.depositsCents, 500000, "A deposits");
  eq(ovB.finance.depositsCents, 170000, "B deposits");
  eq(ovG.finance.depositsCents, 670000, "GLOBAL deposits = A+B");
  eq(ovA.finance.withdrawalsCents, 120000, "A withdrawals");
  eq(ovB.finance.withdrawalsCents, 30000, "B withdrawals");
  eq(ovA.finance.pendingWithdrawals, 1, "A pending withdrawals");
  eq(ovB.finance.pendingWithdrawals, 0, "B pending withdrawals");
  eq(ovA.finance.walletLiabilityCents, 150000, "A wallet liability");
  eq(ovB.finance.walletLiabilityCents, 100000, "B wallet liability");
  eq(ovG.finance.walletLiabilityCents, 250000, "GLOBAL wallet liability");
  eq(ovA.affiliate.marketers, 1, "A affiliates count");
  eq(ovB.affiliate.marketers, 1, "B affiliates count");
  eq(ovG.affiliate.marketers, 2, "GLOBAL affiliates count");
  eq(ovA.affiliate.commissionAccruedCents, 10000, "A commission accrued");
  eq(ovA.affiliate.pendingPayouts, 1, "A pending payouts");
  eq(ovB.affiliate.pendingPayouts, 1, "B pending payouts");
  eq(ovA.game.turnoverCents, 200000, "A turnover"); eq(ovA.game.ggrCents, 50000, "A ggr"); eq(ovA.game.settledPositions, 2, "A settled");
  eq(ovB.game.turnoverCents, 50000, "B turnover"); eq(ovB.game.settledPositions, 1, "B settled");
  eq(ovG.game.turnoverCents, 250000, "GLOBAL turnover");
  eq(ovA.users.marketers, 1, "A marketer-role users"); eq(ovG.users.marketers, 2, "GLOBAL marketer-role users");

  console.log("\n── reportDay (calendar day explorer) ──");
  const rdA = await admin.reportDay(TODAY, A), rdB = await admin.reportDay(TODAY, B), rdG = await admin.reportDay(TODAY);
  eq(rdA.deposits.amountCents, 500000, "A day deposits"); eq(rdB.deposits.amountCents, 170000, "B day deposits");
  eq(rdG.deposits.amountCents, 670000, "GLOBAL day deposits");
  eq(rdA.turnoverCents, 200000, "A day turnover"); eq(rdB.turnoverCents, 50000, "B day turnover");
  eq(rdA.poolBudgetCents, 500000, "A pool budget"); eq(rdB.poolBudgetCents, 200000, "B pool budget");
  eq(rdA.poolPaidCents, 50000, "A pool paid");
  eq(rdA.commissionAccruedCents, 10000, "A day commission"); eq(rdB.commissionAccruedCents, 10000, "B day commission");
  eq(rdG.poolBudgetCents, 700000, "GLOBAL pool budget = A+B");

  console.log("\n── reportDaily / reportByUser ──");
  const rlA = await admin.reportDaily({ from: TODAY, to: TODAY }, A);
  const rlB = await admin.reportDaily({ from: TODAY, to: TODAY }, B);
  eq(rlA.reduce((s, r) => s + r.depositsCents, 0), 500000, "A daily deposits sum");
  eq(rlB.reduce((s, r) => s + r.depositsCents, 0), 170000, "B daily deposits sum");
  const ruA = await admin.reportByUser({ from: TODAY, to: TODAY }, A);
  const ruB = await admin.reportByUser({ from: TODAY, to: TODAY }, B);
  ok(ruA.every((r) => ["a_alice", "a_bob", "a_carol"].includes(r.username)), "reportByUser(A) only A users");
  ok(ruB.every((r) => ["b_dan", "b_eve"].includes(r.username)), "reportByUser(B) only B users");
  ok(ruB.length > 0 && !ruB.some((r) => r.username.startsWith("a_")), "reportByUser(B) excludes A users");

  console.log("\n── rtpMonitor ──");
  const rtA = await admin.rtpMonitor(A), rtB = await admin.rtpMonitor(B);
  const allA = rtA.windows.find((w) => w.window === "all")!, allB = rtB.windows.find((w) => w.window === "all")!;
  eq(allA.turnoverCents, 200000, "A rtp all-window turnover"); eq(allB.turnoverCents, 50000, "B rtp all-window turnover");

  console.log("\n── listUsers / listWithdrawals / listDeposits / listTransactions ──");
  const luA = await admin.listUsers({ siteId: A } as any), luB = await admin.listUsers({ siteId: B } as any);
  eq(luA.items.length, await dbCount("profiles", A), "listUsers(A) count == db A profiles");
  ok(luA.items.every((u) => u.username.startsWith("a_")), "listUsers(A) only A usernames");
  ok(luB.items.every((u) => u.username.startsWith("b_")), "listUsers(B) only B usernames");
  const lwA = await admin.listWithdrawals({ siteId: A } as any);
  eq(lwA.items.length, 2, "listWithdrawals(A) == 2 (1 success + 1 pending)");
  const ldB = await admin.listDeposits({ siteId: B } as any);
  eq(ldB.items.length, 1, "listDeposits(B) == 1");

  console.log("\n── listAudit / listAffiliatePayouts / listSeeds ──");
  const auA = await admin.listAudit({ limit: 100 } as any, A);
  const auB = await admin.listAudit({ limit: 100 } as any, B);
  eq(auA.items.length, await dbCount("admin_actions", A), "listAudit(A) count == db A admin_actions");
  eq(auB.items.length, 1, "listAudit(B) == 1 (only B's ban action)");
  const apA = await admin.listAffiliatePayouts({ siteId: A } as any);
  const apB = await admin.listAffiliatePayouts({ siteId: B } as any);
  const apG = await admin.listAffiliatePayouts({} as any);
  eq(apA.items.length, 1, "listAffiliatePayouts(A) == 1"); eq(apB.items.length, 1, "listAffiliatePayouts(B) == 1");
  eq(apG.items.length, 2, "listAffiliatePayouts(GLOBAL) == 2");
  const sdA = await admin.listSeeds(50, A), sdB = await admin.listSeeds(50, B), sdG = await admin.listSeeds(50);
  eq(sdA.length, 1, "listSeeds(A) == 1"); eq(sdB.length, 1, "listSeeds(B) == 1"); eq(sdG.length, 2, "listSeeds(GLOBAL) == 2");

  console.log("\n── MARKETERS module (the second reported leak) ──");
  const mlA = await mrepo.list(100, A), mlB = await mrepo.list(100, B), mlG = await mrepo.list(100);
  eq(mlA.length, 2, "marketers list(A) == 2"); eq(mlB.length, 1, "marketers list(B) == 1"); eq(mlG.length, 3, "marketers list(GLOBAL) == 3");
  ok(mlA.every((m) => ["0790000001", "0790000002"].includes(m.phone)), "A marketer phones only A's");
  ok(mlB.length === 1 && mlB[0]!.name === "Alice Madolar", "B sees only its own marketer");
  eq(await mrepo.siteOfMarketer(mA1.id), A, "siteOfMarketer(A marketer) == A");
  eq(await mrepo.siteOfMarketer(mB1.id), B, "siteOfMarketer(B marketer) == B");
  ok(mA1.id !== mB1.id, "same phone on A and B => two distinct marketers (per-site identity)");
  // login scoping: A's Alice PIN 1234 works on A, fails on B; B's Alice PIN 9999 works on B, fails on A
  eq(await mrepo.login("0790000001", "1234", A), mA1.id, "login(A alice) on A -> A id");
  eq(await mrepo.login("0790000001", "1234", B), null, "login(A alice PIN) on B -> null (isolated)");
  eq(await mrepo.login("0790000001", "9999", B), mB1.id, "login(B alice) on B -> B id");
  eq(await mrepo.login("0790000001", "9999", A), null, "login(B alice PIN) on A -> null (isolated)");
  const pbA = await mrepo.profileByPhone("0790000001", A), pbB = await mrepo.profileByPhone("0790000001", B);
  ok(pbA?.name === "Alice Njeri" && pbB?.name === "Alice Madolar", "profileByPhone resolves per-brand identity");

  console.log("\n── listTransactions (unified finance explorer) ──");
  const ltA = await admin.listTransactions({ siteId: A } as any);
  const ltB = await admin.listTransactions({ siteId: B } as any);
  eq(ltA.items.length, 4, "listTransactions(A) == 4 (2 dep + 2 wd)");
  eq(ltB.items.length, 2, "listTransactions(B) == 2 (1 dep + 1 wd)");

  console.log("\n── NEW EMPTY BRAND (the exact madolar scenario: freshly onboarded, no data) ──");
  const rc = await q("select fn_platform_create_site($1,'platform_superadmin','freshco','FreshCo','KES','freshco.com') as id", [A]);
  const C = String(rc.rows[0].id);
  const ovC = await admin.overview(C);
  eq(ovC.finance.depositsCents, 0, "empty brand deposits == 0 (NOT the default site's data)");
  eq(ovC.finance.walletLiabilityCents, 0, "empty brand wallet liability == 0");
  eq(ovC.affiliate.marketers, 0, "empty brand affiliates == 0");
  eq(ovC.game.turnoverCents, 0, "empty brand turnover == 0");
  eq((await admin.reportDay(TODAY, C)).deposits.amountCents, 0, "empty brand reportDay deposits == 0");
  eq((await admin.listUsers({ siteId: C } as any)).items.length, 0, "empty brand listUsers == 0");
  eq((await mrepo.list(100, C)).length, 0, "empty brand marketer list == 0 (was showing invest254's before)");
  eq((await admin.listSeeds(50, C)).length, 0, "empty brand seeds == 0");

  console.log("\n── PRE-FIX REGRESSION: a per-brand admin must NOT see the global aggregate ──");
  ok(ovG.finance.depositsCents !== ovA.finance.depositsCents, "GLOBAL deposits != brand-A deposits (fix changes behaviour)");
  ok(ovC.finance.depositsCents !== ovG.finance.depositsCents, "empty brand != global (old bug would have shown global)");
  ok(ovB.finance.depositsCents === 170000 && ovG.finance.depositsCents === 670000, "each brand isolated; only platform sees the sum");

  console.log("\n── IDOR guard: assertTargetSiteInScope (by-id read/write protection) ──");
  const scopedA = { claims: { role: "admin", site: A } } as any;
  const platform = { claims: { role: "platform_superadmin", site: A } } as any;
  let threw = false; try { assertTargetSiteInScope(scopedA, B); } catch { threw = true; }
  ok(threw, "A-admin touching a B target -> SITE_SCOPE_FORBIDDEN");
  threw = false; try { assertTargetSiteInScope(scopedA, A); } catch { threw = true; }
  ok(!threw, "A-admin touching an A target -> allowed");
  threw = false; try { assertTargetSiteInScope(platform, B); } catch { threw = true; }
  ok(!threw, "platform_superadmin touching any target -> allowed (cross-brand)");
  // marketer by-id: an A-admin trying to credit/withdraw/read a B marketer is refused
  threw = false; try { assertTargetSiteInScope(scopedA, await mrepo.siteOfMarketer(mB1.id)); } catch { threw = true; }
  ok(threw, "A-admin touching a B MARKETER by id -> SITE_SCOPE_FORBIDDEN");
  threw = false; try { assertTargetSiteInScope(scopedA, await mrepo.siteOfMarketer(mA1.id)); } catch { threw = true; }
  ok(!threw, "A-admin touching its own A marketer -> allowed");
  // realistic by-id: siteOfUser drives the getUserDetail/activity/overrides/notifications guards
  const soA = await admin.siteOfUser((await q("select id from profiles where username='a_alice'")).rows[0].id);
  eq(soA, A, "siteOfUser(a_alice) == A (guards by-id reads)");

  console.log(`\n==== e2e result: ${pass} passed, ${fail} failed ====`);
  await pool.end();
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
