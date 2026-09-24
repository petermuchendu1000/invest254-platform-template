import type { WalletBalance } from "./app.js";

/**
 * DEMO-1 — Real / Demo account switch over the 0123 RPCs (fn_set_account_mode, fn_topup_demo_account).
 * The money layer decides the bucket for every trade from the stored mode (fn_account_is_demo); the
 * engine agrees via makeDemoAccountResolver. Switching is refused while a contract is open, so a trade
 * can never straddle a switch.
 */
export interface WalletModeQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

const toCents = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

export function makeWalletModeDeps(q: WalletModeQuerier) {
  const siteOf = async (userId: string, siteId?: string): Promise<string | null> =>
    siteId ?? ((await q.query("select site_id from wallets where user_id = $1 limit 1", [userId])).rows[0]?.site_id as string | undefined) ?? null;

  return {
    /** Every bucket + the active account. `real`/`bonus` are what the active account can spend. */
    async balances(userId: string, siteId?: string): Promise<WalletBalance> {
      const r = await q.query(
        `select fn_is_marketer_account(user_id) as marketer, account_mode, real_balance, bonus_balance, demo_balance, currency
           from wallets where user_id = $1 and ($2::uuid is null or site_id = $2)`,
        [userId, siteId ?? null]);
      if (!r.rows.length) return { real: 0, bonus: 0, currency: "KES", mode: "real", modeLocked: false, realBalance: 0, bonusBalance: 0, demoBalance: 0 };
      const x = r.rows[0]!;
      const marketer = x.marketer === true;
      const demo = marketer || x.account_mode === "demo";
      const realB = toCents(x.real_balance), bonusB = toCents(x.bonus_balance), demoB = toCents(x.demo_balance);
      return {
        real: demo ? demoB : realB, bonus: demo ? 0 : bonusB, currency: String(x.currency ?? "KES"),
        mode: demo ? "demo" : "real", modeLocked: marketer, realBalance: realB, bonusBalance: bonusB, demoBalance: demoB,
      };
    },
    async setMode(userId: string, siteId: string | undefined, mode: "real" | "demo"): Promise<"real" | "demo"> {
      const open = await q.query("select 1 from positions where user_id = $1 and status = 'open' limit 1", [userId]);
      if (open.rows.length) throw new Error("OPEN_POSITIONS");
      const m = await q.query("select fn_is_marketer_account($1) as m", [userId]);
      if (m.rows[0]?.m === true && mode === "real") throw new Error("MODE_LOCKED");
      const r = await q.query("select fn_set_account_mode($1, $2, $3) as mode", [userId, await siteOf(userId, siteId), mode]);
      return String(r.rows[0]!.mode) as "real" | "demo";
    },
    async topupDemo(userId: string, siteId?: string): Promise<number> {
      const r = await q.query("select fn_topup_demo_account($1, $2) as b", [userId, await siteOf(userId, siteId)]);
      return toCents(r.rows[0]!.b);
    },
  };
}
