import type { WalletBalance } from "./app.js";

/**
 * DEMO-1 — Real / Demo account switch over the 0123 RPCs (fn_set_account_mode, fn_topup_demo_account).
 * The money layer decides the bucket for every trade from the stored mode (fn_account_is_demo); the
 * engine agrees via makeDemoAccountResolver. Switching is refused while a contract is open, so a trade
 * can never straddle a switch.
 */
export interface WalletModeQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

const toCents = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

/** The demo account opens at 10,000 in the brand's currency (docs: DEMO-2). */
export const DEMO_TARGET_MAJOR = 10_000;
/** 10,000 of the brand currency in KES cents at `fxRateFromKes` (currency per KES). Rounded UP so the
 *  display never reads 9,999.99. KES (or no rate) → KES 10,000. */
export function demoTargetCents(fxRateFromKes: number | null | undefined, currency: string): number {
  if (currency === "KES" || !fxRateFromKes || !Number.isFinite(fxRateFromKes) || fxRateFromKes <= 0) return DEMO_TARGET_MAJOR * 100;
  // within fn_topup_demo_account's bounds (KES 1,000 .. KES 100M): a weak currency (UGX 10,000 ≈ KES 350)
  // gets the KES 1,000 floor instead of a refused refill (BUGLOG #118)
  return Math.min(DEMO_TARGET_MAX_CENTS, Math.max(DEMO_TARGET_MIN_CENTS, Math.ceil((DEMO_TARGET_MAJOR / fxRateFromKes) * 100)));
}
export const DEMO_TARGET_MIN_CENTS = 100_000;
export const DEMO_TARGET_MAX_CENTS = 10_000_000_000;

export function makeWalletModeDeps(q: WalletModeQuerier, rate: (currency: string) => Promise<number> = async () => 0) {
  const siteOf = async (userId: string, siteId?: string): Promise<string | null> =>
    siteId ?? ((await q.query("select site_id from wallets where user_id = $1 limit 1", [userId])).rows[0]?.site_id as string | undefined) ?? null;

  // Methods are handed out unbound (server.ts), so nothing here may use `this`.
  async function topupDemo(userId: string, siteId?: string): Promise<number> {
    const site = await siteOf(userId, siteId);
    const c = await q.query("select coalesce(currency, 'KES') as currency from sites where id = $1::uuid", [site]);
    const currency = String(c.rows[0]?.currency ?? "KES");
    const target = demoTargetCents(currency === "KES" ? 1 : await rate(currency).catch(() => 0), currency);
    const r = await q.query("select fn_topup_demo_account($1, $2, $3) as b", [userId, site, target]);
    return toCents(r.rows[0]!.b);
  }

  return {
    /** Every bucket + the active account. `real`/`bonus` are what the active account can spend. */
    async balances(userId: string, siteId?: string): Promise<WalletBalance> {
      const r = await q.query(
        `select fn_is_marketer_account(user_id) as marketer, account_mode, marketer_practice,
                real_balance, bonus_balance, demo_balance, practice_balance, currency
           from wallets where user_id = $1 and ($2::uuid is null or site_id = $2)`,
        [userId, siteId ?? null]);
      if (!r.rows.length) return { real: 0, bonus: 0, currency: "KES", mode: "real", modeLocked: false, realBalance: 0, bonusBalance: 0, demoBalance: 0 };
      const x = r.rows[0]!;
      const marketer = x.marketer === true;
      const demo = marketer || x.account_mode === "demo";
      const realB = toCents(x.real_balance), bonusB = toCents(x.bonus_balance), demoB = toCents(x.demo_balance), practiceB = toCents(x.practice_balance);
      // 0176: a MARKETER is presented as a normal player. Their funny money (demo_balance) is their
      // Real account; practice_balance is their separate Demo. `marketer_practice` is the Real/Demo
      // switch — account_mode stays 'demo' (so pool exemption / auto-refund are untouched), and the
      // active spendable follows the switch. `demoBalance` keeps its literal meaning (the funny/demo
      // bucket); the practice bucket is its own field.
      if (marketer) {
        const practice = x.marketer_practice === true;
        return {
          real: practice ? practiceB : demoB, bonus: 0, currency: String(x.currency ?? "KES"),
          mode: "demo", modeLocked: true, realBalance: realB, bonusBalance: bonusB,
          demoBalance: demoB, practiceBalance: practiceB, marketerPractice: practice,
        };
      }
      return {
        real: demo ? demoB : realB, bonus: demo ? 0 : bonusB, currency: String(x.currency ?? "KES"),
        mode: demo ? "demo" : "real", modeLocked: false, realBalance: realB, bonusBalance: bonusB,
        demoBalance: demoB, practiceBalance: practiceB, marketerPractice: false,
      };
    },
    async setMode(userId: string, siteId: string | undefined, mode: "real" | "demo"): Promise<"real" | "demo"> {
      const open = await q.query("select 1 from positions where user_id = $1 and status = 'open' limit 1", [userId]);
      if (open.rows.length) throw new Error("OPEN_POSITIONS");
      const m = await q.query("select fn_is_marketer_account($1) as m", [userId]);
      const site = await siteOf(userId, siteId);
      // 0176: for a MARKETER the Real/Demo switch is the practice flag, NOT account_mode (which stays
      // 'demo'). Real => funny money (their withdrawable account); Demo => the separate practice bucket.
      if (m.rows[0]?.m === true) {
        await q.query("select fn_set_marketer_practice($1, $2, $3)", [userId, site, mode === "demo"]);
        // DEMO-2 parity: a marketer's practice (Demo) bucket opens FUNDED to 10,000 too, so it is never
        // an empty 0 the way a player's demo never is. fn_topup_demo_account targets practice now that
        // the flag is set, and only tops up when it cannot place the minimum stake (spent, or new).
        if (mode === "demo") {
          const b = await q.query(
            `select w.practice_balance, coalesce(c.min_stake, 1) as min_stake from wallets w
               left join site_game_config c on c.site_id = w.site_id
              where w.user_id = $1 and ($2::uuid is null or w.site_id = $2)`, [userId, site]);
          const x = b.rows[0];
          if (x && toCents(x.practice_balance) < Math.max(1, toCents(x.min_stake))) await topupDemo(userId, site ?? undefined).catch(() => 0);
        }
        return mode;
      }
      const r = await q.query("select fn_set_account_mode($1, $2, $3) as mode", [userId, site, mode]);
      const now = String(r.rows[0]!.mode) as "real" | "demo";
      // DEMO-2: a demo account that cannot place the minimum stake (new, or spent) opens funded, so the
      // player sees 10,000 at once instead of 0 until they find "Refresh".
      if (now === "demo" && m.rows[0]?.m !== true) {
        const b = await q.query(
          `select w.demo_balance, coalesce(c.min_stake, 1) as min_stake from wallets w
             left join site_game_config c on c.site_id = w.site_id
            where w.user_id = $1 and ($2::uuid is null or w.site_id = $2)`, [userId, site]);
        const x = b.rows[0];
        // best effort: the switch has happened; a failed refill must not report the switch as failed
        if (x && toCents(x.demo_balance) < Math.max(1, toCents(x.min_stake))) await topupDemo(userId, site ?? undefined).catch(() => 0);
      }
      return now;
    },
    topupDemo,
  };
}
