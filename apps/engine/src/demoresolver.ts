/**
 * "Is this a demo account?" for the game engine's pool exemption (docs/25 §8, migrations 0084/0123).
 *
 * A demo account is a MARKETER (always demo) or a PLAYER whose wallet is in demo mode. The money
 * RPCs already debit the demo bucket for both (fn_account_is_demo), so the engine must agree: a demo
 * trade never reserves or commits the real payout pool and never counts towards pool turnover.
 *
 * DEMO-1 (owner-authorised 2026-09-24). Marketer status is cached for 60s (it rarely changes); the
 * wallet's account mode is read fresh on every trade because a player can switch it at any time
 * (the API refuses a switch while a contract is open, so an in-flight trade can't straddle a switch).
 * On a lookup failure it fails toward the REAL path (the DB RPC still routes the money correctly).
 */
export interface DemoQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

export function makeDemoAccountResolver(q: DemoQuerier, now: () => number = () => Date.now()) {
  const marketerCache = new Map<string, { v: boolean; exp: number }>();
  return async (userId: string): Promise<boolean> => {
    const t = now();
    const hit = marketerCache.get(userId);
    try {
      let marketer: boolean;
      if (hit && hit.exp > t) marketer = hit.v;
      else {
        const r = await q.query("select fn_is_marketer_account($1) as m", [userId]);
        marketer = r.rows[0]?.m === true;
        marketerCache.set(userId, { v: marketer, exp: t + 60_000 });
      }
      if (marketer) return true;
      const d = await q.query("select coalesce(bool_or(account_mode = 'demo'), false) as d from wallets where user_id = $1", [userId]);
      return d.rows[0]?.d === true;
    } catch {
      return hit?.v ?? false;
    }
  };
}
