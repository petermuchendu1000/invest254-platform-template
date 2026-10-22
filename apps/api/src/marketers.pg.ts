import type { MarketerRepo, TransferResult, MarketerRow, MarketerProfile, MarketerLedgerRow, WithdrawResult, AirtimeResult } from "./app.marketers.js";

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
    affiliate_user_id: r.affiliate_user_id ?? null,
    sessions_valid_after: r.sessions_valid_after ?? null,
    email: r.email ?? null,
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
        `SELECT mp.*,
                (select p.id from public.profiles p
                  where public.fn_phone_sig9(p.phone) = public.fn_phone_sig9(mp.phone)
                    and p.site_id = mp.site_id and p.role = 'marketer'
                  order by p.created_at asc limit 1) as affiliate_user_id
           FROM public.marketer_profiles mp
          WHERE ($2::uuid IS NULL OR mp.site_id = $2)
          ORDER BY mp.created_at DESC LIMIT $1`,
        [limit, siteId ?? null]);
      return rows.map(toProfile);
    },

    async profile(id): Promise<MarketerProfile | null> {
      const { rows } = await query("SELECT * FROM public.marketer_profiles WHERE id = $1", [id]);
      return rows.length ? toProfile(rows[0]) : null;
    },

    async profileByPhone(phone, siteId): Promise<MarketerProfile | null> {
      // Match on the canonical significant-9-digits rule (fn_phone_sig9, migration 0086) — the same
      // predicate every other marketer lookup uses (0084/0086/0100). The marketer apps send the phone
      // exactly as typed, so a raw `phone = $1` exact match missed any format other than the stored
      // one (e.g. +254…/254…/bare/spaced vs stored 07…) and wrongly returned NOT_MARKETER after a
      // successful password login (which normalizes via normalizeMsisdn). See docs/BUGLOG.md.
      const { rows } = await query(
        `SELECT * FROM public.marketer_profiles
          WHERE public.fn_phone_sig9(phone) = public.fn_phone_sig9($1)
            AND length(public.fn_phone_sig9($1)) = 9
            AND ($2::uuid IS NULL OR site_id = $2)
          ORDER BY created_at ASC LIMIT 1`,
        [phone, siteId ?? null]);
      return rows.length ? toProfile(rows[0]) : null;
    },

    async topupDemo(id, capCents): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_topup_demo($1, $2) AS balance", [id, capCents]);
      return num(rows[0].balance);
    },
    async transfer(fromId, toId, amountCents, ref, meta, dailyCapCents): Promise<TransferResult> {
      // ONE statement on purpose. The debit, the credit and both ledger rows live inside the RPC,
      // so there is no window in which this process could die having moved half a transfer.
      const { rows } = await query(
        "SELECT public.fn_marketer_transfer($1, $2, $3, $4, $5::jsonb, $6) AS r",
        [fromId, toId, amountCents, ref, JSON.stringify(meta ?? {}), dailyCapCents]);
      const r = rows[0].r as Record<string, unknown>;
      return {
        idempotent: r.idempotent === true,
        from_balance_cents: num(r.from_balance_cents),
        to_balance_cents: num(r.to_balance_cents),
        out_ledger_id: num(r.out_ledger_id),
        in_ledger_id: num(r.in_ledger_id),
        recipient_name: String(r.recipient_name ?? ""),
        sent_cents: num(r.sent_cents),
        // 0205. Absent on a database still at 0203 — the route falls back to its own clock rather
        // than failing the send, which is what lets migrate and deploy happen in either order.
        ...(typeof r.out_created_at === "string" ? { out_created_at: r.out_created_at } : {}),
      };
    },
    async credit(id, amountCents, ref, meta, actor): Promise<number> {
      // 0199/A1: $5/$6 = the admin actor for the DB brand fence; NULL (internal/system path) => no-op.
      const { rows } = await query(
        "SELECT public.fn_marketer_credit($1, $2, $3, $4::jsonb, $5, $6) AS balance",
        [id, amountCents, ref, JSON.stringify(meta ?? {}), actor?.id ?? null, actor?.role ?? null]);
      return num(rows[0].balance);
    },

    async withdraw(id, amountCents, ref, meta, method, actor): Promise<WithdrawResult> {
      const { rows } = await query(
        "SELECT public.fn_marketer_withdraw($1, $2, $3, $4::jsonb, $5, $6, $7) AS r",
        [id, amountCents, ref, JSON.stringify(meta ?? {}), method, actor?.id ?? null, actor?.role ?? null]);
      // fn returns jsonb; node-postgres parses it to an object already.
      const r = rows[0].r as WithdrawResult;
      return { ...r, balance_cents: num(r.balance_cents), ledger_id: num(r.ledger_id) };
    },

    async setFuliza(id, amountCents, actor): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_set_fuliza($1, $2, $3, $4) AS v",
        [id, amountCents, actor?.id ?? null, actor?.role ?? null]);
      return num(rows[0].v);
    },

    async setAirtime(id, amountCents, actor): Promise<number> {
      const { rows } = await query("SELECT public.fn_marketer_set_airtime($1, $2, $3, $4) AS v",
        [id, amountCents, actor?.id ?? null, actor?.role ?? null]);
      return num(rows[0].v);
    },

    async setEmail(id, email): Promise<string | null> {
      const { rows } = await query("SELECT public.fn_marketer_set_email($1, $2) AS v", [id, email]);
      return (rows[0].v as string | null) ?? null;
    },

    async buyAirtime(id, amountCents, ref, meta, minCents): Promise<AirtimeResult> {
      // ONE statement: the debit, the airtime credit and the ledger row are inside the RPC, so no
      // crash can leave a wallet that paid for airtime it did not receive.
      const { rows } = await query(
        "SELECT public.fn_marketer_buy_airtime($1, $2, $3, $4::jsonb, $5) AS r",
        [id, amountCents, ref, JSON.stringify(meta ?? {}), minCents]);
      const r = rows[0].r as Record<string, unknown>;
      return {
        idempotent: r.idempotent === true,
        balance_cents: num(r.balance_cents),
        airtime_balance_cents: num(r.airtime_balance_cents),
        ledger_id: num(r.ledger_id),
        ...(typeof r.created_at === "string" ? { created_at: r.created_at } : {}),
      };
    },

    async statementSummary(id, fromIso, toIso) {
      // Aggregated in SQL over the WHOLE range — see 0206's header on why this is not derived from
      // the capped detail below.
      const { rows } = await query(
        "SELECT public.fn_marketer_statement_summary($1, $2::timestamptz, $3::timestamptz) AS r",
        [id, fromIso, toIso]);
      const r = rows[0].r as Record<string, unknown>;
      const buckets: Record<string, { in: number; out: number }> = {};
      for (const [k, v] of Object.entries((r.buckets ?? {}) as Record<string, { in: number; out: number }>)) {
        buckets[k] = { in: num(v.in), out: num(v.out) };
      }
      return {
        buckets,
        txn_count: num(r.txn_count),
        paid_in_cents: num(r.paid_in_cents),
        paid_out_cents: num(r.paid_out_cents),
      };
    },

    async statementRange(id, fromIso, toIso, cap): Promise<MarketerLedgerRow[]> {
      const { rows } = await query(
        "SELECT * FROM public.fn_marketer_statement_range($1, $2::timestamptz, $3::timestamptz, $4)",
        [id, fromIso, toIso, cap]);
      return rows.map((r) => ({
        id: num(r.id),
        entry_type: r.entry_type,
        amount_cents: num(r.amount_cents),
        balance_after_cents: num(r.balance_after_cents),
        ref: r.ref ?? null,
        meta: r.meta ?? {},
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
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

    async setPin(id, pin, actor): Promise<void> {
      // 0199/A1: $3/$4 = the admin actor for the DB brand fence; NULL (self-service reset) => no-op.
      await query("SELECT public.fn_marketer_set_pin($1, $2, $3, $4)", [id, pin, actor?.id ?? null, actor?.role ?? null]);
    },

    async login(phone, pin, siteId): Promise<string | null> {
      // 3-arg site-aware RPC (0076). NULL => the function's default site (coalesce inside the RPC).
      const { rows } = await query("SELECT public.fn_marketer_login($1, $2, $3) AS id", [phone, pin, siteId ?? null]);
      return rows[0]?.id ?? null;
    },

    async changePin(id, currentPin, newPin): Promise<void> {
      await query("SELECT public.fn_marketer_change_pin($1, $2, $3)", [id, currentPin, newPin]);
    },

    async setStatus(id, status, actor): Promise<string> {
      const { rows } = await query("SELECT public.fn_marketer_set_status($1, $2, $3, $4) AS s",
        [id, status, actor?.id ?? null, actor?.role ?? null]);
      return rows[0].s as string;
    },

    async delete(id, siteId): Promise<{ deleted: boolean }> {
      // HARD delete; marketer_wallets/ledger/withdrawals/credentials all CASCADE. Brand-scoped when
      // siteId is given so a site admin can't delete another brand's marketer.
      const { rows } = await query(
        "DELETE FROM public.marketers WHERE id = $1 AND ($2::uuid IS NULL OR site_id = $2) RETURNING id",
        [id, siteId ?? null]);
      return { deleted: rows.length > 0 };
    },

    // ── Security questions + force-logout (0198) ──
    async getSecurityAnswers(id): Promise<{ questionKey: string; answerHash: string }[]> {
      const { rows } = await query(
        "SELECT question_key, answer_hash FROM public.marketer_security_answers WHERE marketer_id = $1 ORDER BY question_key",
        [id]);
      return rows.map((r) => ({ questionKey: String(r.question_key), answerHash: String(r.answer_hash) }));
    },

    async setSecurityAnswers(id, answers): Promise<void> {
      // Single atomic statement, mirroring the user_security_answers upsert (identity.ts): upsert the
      // submitted (key, hash) pairs and delete any stored key not in the new set, so the persisted set
      // is EXACTLY `answers`. unnest() zips the two arrays.
      const keys = answers.map((a) => a.questionKey);
      const hashes = answers.map((a) => a.answerHash);
      await query(
        `with input as (
           select question_key, answer_hash
             from unnest($2::text[], $3::text[]) as t(question_key, answer_hash)
         ), del as (
           delete from public.marketer_security_answers
            where marketer_id = $1 and question_key not in (select question_key from input)
         )
         insert into public.marketer_security_answers (marketer_id, question_key, answer_hash)
         select $1, question_key, answer_hash from input
         on conflict (marketer_id, question_key)
           do update set answer_hash = excluded.answer_hash, updated_at = now()`,
        [id, keys, hashes]);
    },

    async forceLogout(id): Promise<void> {
      // now() from the DATABASE, so a skewed app clock cannot stamp an epoch in the past and leave a
      // just-issued token alive. Mirrors identity.ts stampForceLogout for the marketers.id identity.
      await query("UPDATE public.marketers SET sessions_valid_after = now(), updated_at = now() WHERE id = $1", [id]);
    },
  };
}
