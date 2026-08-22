import type { MarketerRepo, MarketerRow, MarketerProfile, MarketerLedgerRow, WithdrawResult } from "./app.marketers.js";

/** Minimal query surface (node-postgres Pool/Client satisfy this). */
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** node-postgres returns bigint columns as strings; coerce the cents fields to numbers. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function toProfile(r: any): MarketerProfile {
  return {
    id: r.id,
    name: r.name,
    first_name: r.first_name,
    initials: r.initials,
    phone: r.phone,
    status: r.status,
    balance_cents: num(r.balance_cents),
    available_fuliza_cents: num(r.available_fuliza_cents),
    airtime_balance_cents: num(r.airtime_balance_cents),
    currency: r.currency,
    site_id: r.site_id ?? null,
    brand_name: r.brand_name ?? null,
  };
}

/**
 * Postgres-backed marketer repository. Every mutation is a single call to an atomic,
 * row-locking RPC from migration 0033_marketers, so all the guards (non-negative balance,
 * overdraw block, idempotency by `ref`) live in the database.
 */
export function makePgMarketerRepo(query: Query): MarketerRepo {
  return {
    async create(name, phone, siteId): Promise<MarketerRow> {
      // 3-arg site-aware RPC (0076). NULL => the function's default site (coalesce inside the RPC).
      const { rows } = await query("SELECT * FROM public.fn_marketer_create($1, $2, $3)", [name, phone, siteId ?? null]);
      return rows[0] as MarketerRow;
    },

    async update(id, name, phone): Promise<MarketerRow> {
      const { rows } = await query("SELECT * FROM public.fn_marketer_update($1, $2, $3)", [id, name ?? null, phone ?? null]);
      return rows[0] as MarketerRow;
    },

    async list(limit, siteId): Promise<MarketerProfile[]> {
      const { rows } = await query(
        "SELECT * FROM public.marketer_profiles WHERE ($2::uuid IS NULL OR site_id = $2) ORDER BY created_at DESC LIMIT $1",
        [limit, siteId ?? null]);
      return rows.map(toProfile);
    },

    async profile(id): Promise<MarketerProfile | null> {
      const { rows } = await query("SELECT * FROM public.marketer_profiles WHERE id = $1", [id]);
      return rows.length ? toProfile(rows[0]) : null;
    },

    async profileByPhone(phone, siteId): Promise<MarketerProfile | null> {
      const { rows } = await query(
        "SELECT * FROM public.marketer_profiles WHERE phone = $1 AND ($2::uuid IS NULL OR site_id = $2)",
        [phone, siteId ?? null]);
      return rows.length ? toProfile(rows[0]) : null;
    },

    async topupDemo(id, capCents): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_topup_demo($1, $2) AS balance", [id, capCents]);
      return num(rows[0].balance);
    },
    async credit(id, amountCents, ref, meta): Promise<number> {
      const { rows } = await query(
        "SELECT public.fn_marketer_credit($1, $2, $3, $4::jsonb) AS balance",
        [id, amountCents, ref, JSON.stringify(meta ?? {})]);
      return num(rows[0].balance);
    },

    async withdraw(id, amountCents, ref, meta, method): Promise<WithdrawResult> {
      const { rows } = await query(
        "SELECT public.fn_marketer_withdraw($1, $2, $3, $4::jsonb, $5) AS r",
        [id, amountCents, ref, JSON.stringify(meta ?? {}), method]);
      // fn returns jsonb; node-postgres parses it to an object already.
      const r = rows[0].r as WithdrawResult;
      return { ...r, balance_cents: num(r.balance_cents), ledger_id: num(r.ledger_id) };
    },

    async setFuliza(id, amountCents): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_set_fuliza($1, $2) AS v", [id, amountCents]);
      return num(rows[0].v);
    },

    async setAirtime(id, amountCents): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_set_airtime($1, $2) AS v", [id, amountCents]);
      return num(rows[0].v);
    },

    async statement(id, limit): Promise<MarketerLedgerRow[]> {
      const { rows } = await query("SELECT * FROM public.fn_marketer_statement($1, $2)", [id, limit]);
      return rows.map((r) => ({
        id: num(r.id),
        entry_type: r.entry_type,
        amount_cents: num(r.amount_cents),
        balance_after_cents: num(r.balance_after_cents),
        ref: r.ref,
        meta: r.meta,
        created_at: r.created_at,
      }));
    },

    async setPin(id, pin): Promise<void> {
      await query("SELECT public.fn_marketer_set_pin($1, $2)", [id, pin]);
    },

    async login(phone, pin, siteId): Promise<string | null> {
      // 3-arg site-aware RPC (0076). NULL => the function's default site (coalesce inside the RPC).
      const { rows } = await query("SELECT public.fn_marketer_login($1, $2, $3) AS id", [phone, pin, siteId ?? null]);
      return rows[0]?.id ?? null;
    },

    async changePin(id, currentPin, newPin): Promise<void> {
      await query("SELECT public.fn_marketer_change_pin($1, $2, $3)", [id, currentPin, newPin]);
    },

    async setStatus(id, status): Promise<string> {
      const { rows } = await query("SELECT public.fn_marketer_set_status($1, $2) AS s", [id, status]);
      return rows[0].s as string;
    },
  };
}
