/**
 * e2e for the referral READ layer + HTTP endpoints (professional dashboard data).
 * Drives the real PgReferralRepository AND the real API (/me/referral*) against a seeded
 * commission chain on a fresh Postgres. Run: DBU=... node --import tsx e2e_referral_reads.mts
 */
import pg from "pg";
import { PgReferralRepository, PgAdminRepository } from "@invest254/engine";
import { makePgMarketerRepo } from "./apps/api/src/marketers.pg.ts";
import { startTestApi } from "./apps/api/src/testutil.ts";

const pool = new pg.Pool({ connectionString: process.env.DBU! });
const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
const A = "00000000-0000-0000-0000-000000000001";
const HASH = "scrypt$32768$8$1$" + "a".repeat(24) + "$" + "b".repeat(24);
let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, m: string) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (ok) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}\n       got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); } };
const ok = (c: boolean, m: string) => eq(!!c, true, m);

const reg = async (phone: string, user: string, code?: string) =>
  String((await q("select user_id from fn_register_user($1,$2,$3,$4,$5::uuid)", [phone, user, HASH, code ?? null, A])).rows[0].user_id);
const enroll = (uid: string) => q("select fn_affiliate_enroll($1)", [uid]);
const code = async (uid: string) => (await q("select referral_code from profiles where id=$1", [uid])).rows[0].referral_code as string;
async function deposit(uid: string, amt: number, phone: string) {
  const tx = (await q("select fn_create_deposit($1,$2,$3,$4::uuid) id", [uid, amt, phone, A])).rows[0].id;
  await q("update transactions set checkout_request_id=$1 where id=$2", [`chk-${tx}`, tx]);
  await q("select fn_complete_deposit($1,0,'ok','RCPT','{}'::jsonb)", [`chk-${tx}`]);
}

async function main() {
  // chain: mkt3 (L3) <- mkt2 (L2) <- mkt1 (L1) <- player ; and pref(player) <- p2
  const mkt3 = await reg("254700000003", "mkt3"); await enroll(mkt3);
  const mkt2 = await reg("254700000002", "mkt2", await code(mkt3)); await enroll(mkt2);
  const mkt1 = await reg("254700000001", "mkt1", await code(mkt2)); await enroll(mkt1);
  const player = await reg("254700000010", "player_p", await code(mkt1));
  await deposit(player, 100000, "254700000010");     // -> mkt1 25k, mkt2 20k, mkt3 17k
  const pref = await reg("254700000020", "prefplayer");
  const p2 = await reg("254700000021", "player2", await code(pref));
  await deposit(p2, 100000, "254700000021");          // -> pref 5k (player rate)

  const ref = new PgReferralRepository(pool as any);

  console.log("\n── PgReferralRepository.earnings (by level) ──");
  eq((await ref.earnings(mkt1, A)).totalCents, 25000, "mkt1 total = 25000");
  eq((await ref.earnings(mkt1, A)).byLevel.l1, 25000, "mkt1 L1 = 25000");
  eq((await ref.earnings(mkt2, A)).byLevel.l2, 20000, "mkt2 L2 = 20000");
  eq((await ref.earnings(mkt3, A)).byLevel.l3, 17000, "mkt3 L3 = 17000");
  eq((await ref.earnings(pref, A)).playerReferralCents, 5000, "player-referrer playerReferralCents = 5000");

  console.log("\n── info: code + counts, unified with affiliate code ──");
  const info1 = await ref.info(mkt1, A);
  ok(!!info1.code && info1.referralPath === `/r/${info1.code}`, "mkt1 has code + referralPath");
  eq(info1.code, await code(mkt1), "info.code == unified profiles.referral_code (== affiliate code)");
  eq(info1.referredCount, 1, "mkt1 referredCount = 1 (the player)");
  eq((await ref.info(mkt2, A)).downlineMarketers, 1, "mkt2 downlineMarketers = 1 (mkt1)");

  console.log("\n── history feed ──");
  const h = await ref.history(mkt1, A, {});
  eq(h.items.length, 1, "mkt1 history has 1 event");
  eq([h.items[0]!.level, h.items[0]!.commissionCents, h.items[0]!.referredUsername], [1, 25000, "player_p"], "event: L1, 25000, player_p");

  console.log("\n── referred breakdown (deposited vs played vs unplayed transparency) ──");
  const rb = await ref.referred(mkt1, A);
  eq(rb.length, 1, "mkt1 has 1 referred player");
  eq([rb[0]!.depositsCents, rb[0]!.playedCents, rb[0]!.unplayedCents, rb[0]!.commissionCents],
     [100000, 0, 100000, 25000], "player: deposited 100000, played 0, unplayed 100000, commission 25000");

  console.log("\n── FULL HTTP: GET /me/referral* with the marketer's own token ──");
  const api = await startTestApi({ depsOverrides: {
    admin: new PgAdminRepository(pool as any) as any,
    marketers: makePgMarketerRepo((sql, p) => pool.query(sql, p ?? [])),
    referral: ref as any,
  } } as any);
  const get = async (path: string, token: string) => {
    const r = await fetch(`${api.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: r.status < 400 ? await r.json() as any : null };
  };
  try {
    const T1 = `${mkt1}:marketer:${A}`;
    const me = await get("/api/v1/me/referral", T1);
    eq(me.body.earnings.totalCents, 25000, "HTTP /me/referral mkt1 earnings 25000");
    ok(typeof me.body.code === "string" && me.body.link.includes(me.body.code), "HTTP /me/referral returns code + link");
    const hist = await get("/api/v1/me/referral/commissions", T1);
    eq(hist.body.items.length, 1, "HTTP /me/referral/commissions -> 1");
    const refd = await get("/api/v1/me/referral/referred", T1);
    eq(refd.body.items[0].unplayedCents, 100000, "HTTP /me/referral/referred shows unplayed 100000");
    // a plain PLAYER referrer can see their referral view too (not marketer-gated)
    const TP = `${pref}:player:${A}`;
    eq((await get("/api/v1/me/referral", TP)).body.earnings.playerReferralCents, 5000, "HTTP: player referrer sees 5000");
    // unauth -> 401
    eq((await fetch(`${api.baseUrl}/api/v1/me/referral`)).status, 401, "HTTP /me/referral unauth -> 401");
    console.log(`\n==== referral reads e2e: ${pass} passed, ${fail} failed ====`);
  } finally { await api.close(); await pool.end(); }
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
