/**
 * STAKE-1 (BUGLOG #87) — stake limits in the brand's own currency.
 *
 * The admin sets min/max in the brand currency (multiples of 5). The engine enforces KES cents
 * (site_game_config.min_stake / max_stake), so those are written from the native values at the live
 * rate: exact for KES brands; for foreign brands with a 10% margin (min rounded down, max up) so a
 * normal FX move can never make the engine refuse a stake the player's pills offer. The player UI
 * enforces the native values exactly.
 */
export interface StakeNativeStore {
  get(siteId: string): Promise<{ min: number; max: number } | null>;
  set(siteId: string, userId: string, min: number, max: number): Promise<void>;
  currency(siteId: string): Promise<string | null>;
  /** The brand changed currency: native values no longer mean anything (BUGLOG #119). */
  clear(siteId: string): Promise<void>;
}

export const FX_MARGIN = 0.1;
export const MAX_NATIVE = 1_000_000_000;

export function validateNative(min: unknown, max: unknown): { min: number; max: number } | string {
  const a = Number(min), b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "min and max must be numbers";
  const m5 = (v: number) => Math.abs(v / 5 - Math.round(v / 5)) < 1e-9;
  if (a < 5 || !m5(a)) return "min must be a multiple of 5, at least 5";
  if (!m5(b) || b < a) return "max must be a multiple of 5, at least min";
  if (b > MAX_NATIVE) return "max is too large";
  return { min: a, max: b };
}

/** Native → the KES cents the engine enforces. `rate` = brand currency per 1 KES (1 for KES). */
export function enforcedCents(min: number, max: number, currency: string, rate: number): { minCents: number; maxCents: number } | null {
  if (currency === "KES") return { minCents: Math.round(min * 100), maxCents: Math.round(max * 100) };
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    minCents: Math.max(1, Math.floor((min / rate) * 100 * (1 - FX_MARGIN))),
    maxCents: Math.ceil((max / rate) * 100 * (1 + FX_MARGIN)),
  };
}

export interface PgLike { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export function makePgStakeNativeStore(q: PgLike): StakeNativeStore {
  return {
    async get(siteId) {
      const r = await q.query("select min_native, max_native from site_stake_native where site_id = $1::uuid", [siteId]);
      const x = r.rows[0];
      return x ? { min: Number(x.min_native), max: Number(x.max_native) } : null;
    },
    async set(siteId, userId, min, max) {
      await q.query(
        `insert into site_stake_native(site_id, min_native, max_native, updated_by, updated_at) values ($1::uuid, $2, $3, $4::uuid, now())
         on conflict (site_id) do update set min_native = excluded.min_native, max_native = excluded.max_native,
           updated_by = excluded.updated_by, updated_at = now()`,
        [siteId, min, max, userId]);
    },
    async clear(siteId) {
      await q.query("delete from site_stake_native where site_id = $1::uuid", [siteId]);
    },
    async currency(siteId) {
      const r = await q.query("select coalesce(currency, 'KES') as c from sites where id = $1::uuid", [siteId]);
      return r.rows[0] ? String(r.rows[0].c) : null;
    },
  };
}
