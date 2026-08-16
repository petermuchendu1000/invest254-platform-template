-- 0062_withdrawal_pool.sql — Phase 1 of the pool-brain (docs/25): schema + per-brand flag +
-- superadmin daily-set RPC. FULLY INERT: no engine/settlement behaviour changes until later phases
-- flip a brand's pool_mode ON and wire the controller (0063+). Additive + idempotent.
--
-- Day boundary is EAT (Africa/Nairobi, UTC+3, no DST) per the operator decision: a "day" is EAT
-- midnight->midnight. fn_eat_day() maps any instant to its EAT calendar date; the pool is keyed by it.

-- ── EAT day helper (immutable-ish; STABLE is correct since tz rules are fixed for Nairobi) ─────────
create or replace function public.fn_eat_day(p_ts timestamptz default now())
returns date language sql stable as $$ select (p_ts at time zone 'Africa/Nairobi')::date $$;

-- ── Per-brand flag: is this brand governed by the pool controller? Default OFF (statistical brain) ──
alter table public.sites add column if not exists pool_mode boolean not null default false;

-- ── The daily payout budget, one row per (brand, EAT day) ─────────────────────────────────────────
create table if not exists public.withdrawal_pool (
  site_id        uuid not null references public.sites(id) on delete cascade,
  trade_day      date not null,                                  -- EAT calendar day (fn_eat_day)
  amount_cents   bigint not null default 0 check (amount_cents >= 0),   -- max total winnings that day
  paid_cents     bigint not null default 0 check (paid_cents  >= 0),    -- winnings COMMITTED (settled) today
  reserved_cents bigint not null default 0 check (reserved_cents >= 0), -- winnings RESERVED for in-flight decided-wins
  set_by         uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (site_id, trade_day),
  -- available = amount - paid - reserved must never go negative (the hard-cap invariant, phase 3+)
  constraint pool_nonneg_available check (amount_cents - paid_cents - reserved_cents >= 0)
);
create index if not exists withdrawal_pool_day_idx on public.withdrawal_pool(trade_day);

-- ── Immutable audit of every pool movement (reserve/commit/release) — source of truth for recovery
--    + reconciliation. Populated by the controller RPCs in a later phase; created now for stability. ──
create table if not exists public.pool_ledger (
  id          bigserial primary key,
  site_id     uuid not null references public.sites(id) on delete cascade,
  trade_day   date not null,
  position_id uuid,
  kind        text not null check (kind in ('reserve','commit','release')),
  amount_cents bigint not null,
  created_at  timestamptz not null default now()
);
create index if not exists pool_ledger_site_day_idx on public.pool_ledger(site_id, trade_day);
create index if not exists pool_ledger_position_idx  on public.pool_ledger(position_id);

-- ── Per-position controller decision (reproducible/auditable; REPLACES the seed as the outcome
--    source of truth in pool mode). Written by the controller in a later phase. ──────────────────────
create table if not exists public.position_decision (
  position_id         uuid primary key,
  site_id             uuid not null,
  pool_day            date not null,
  decided_result      text not null check (decided_result in ('win','loss')),
  decided_multiplier  numeric,
  decided_payout_cents bigint not null default 0,
  decision_seed       text not null,
  pacing_snapshot     jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists position_decision_site_day_idx on public.position_decision(site_id, pool_day);

-- ── Superadmin sets a brand's daily pool (idempotent upsert; keeps paid/reserved). Audited. ─────────
create or replace function public.fn_admin_set_withdrawal_pool(
  p_actor uuid, p_actor_role text, p_site uuid, p_day date, p_amount bigint
) returns public.withdrawal_pool
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.withdrawal_pool; v_before jsonb;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  select to_jsonb(w) into v_before from public.withdrawal_pool w where w.site_id=p_site and w.trade_day=p_day;

  insert into public.withdrawal_pool as w (site_id, trade_day, amount_cents, set_by, updated_at)
    values (p_site, p_day, p_amount, p_actor, now())
  on conflict (site_id, trade_day) do update
    set amount_cents = excluded.amount_cents, set_by = p_actor, updated_at = now()
    -- guard: cannot set the daily budget BELOW what has already been paid+reserved today
    where excluded.amount_cents >= w.paid_cents + w.reserved_cents
  returning * into v_row;

  if v_row.site_id is null then
    -- the WHERE on the DO UPDATE failed -> the new amount would underflow committed liability
    raise exception 'AMOUNT_BELOW_COMMITTED';
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool.set', 'withdrawal_pool', p_site::text || ':' || p_day::text,
            jsonb_build_object('before', v_before, 'after', to_jsonb(v_row)), p_site);
  return v_row;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_admin_set_withdrawal_pool(uuid,text,uuid,date,bigint) from public, anon, authenticated;
  grant  execute on function public.fn_admin_set_withdrawal_pool(uuid,text,uuid,date,bigint) to service_role;
  revoke all on function public.fn_eat_day(timestamptz) from public;
  grant  execute on function public.fn_eat_day(timestamptz) to service_role, authenticated;
end
$g$;
