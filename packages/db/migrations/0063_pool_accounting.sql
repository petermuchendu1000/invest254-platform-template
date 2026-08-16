-- 0063_pool_accounting.sql — Phase 3a of the pool-brain (docs/25): atomic budget accounting.
-- The controller (engine) will call these to move a decided win through reserve -> commit (paid) or
-- reserve -> release (freed). The withdrawal_pool CHECK (amount - paid - reserved >= 0, migration 0062)
-- is the DB-level HARD CAP; these RPCs can never breach it. All SECURITY DEFINER, service-role only,
-- idempotent by position_id, and race-safe via FOR UPDATE on the day's pool row. Still INERT until the
-- engine wires them behind a brand's pool_mode (Phase 3b). Additive + idempotent (CREATE OR REPLACE).

-- Outstanding reservation still held by a position = Σreserve − Σcommit − Σrelease from pool_ledger.
create or replace function public.fn_pool_outstanding(p_position uuid)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(case kind when 'reserve' then amount_cents else -amount_cents end), 0)::bigint
    from public.pool_ledger where position_id = p_position
$$;

-- Reserve up to p_amount of the day's remaining budget for a decided win. Returns the amount ACTUALLY
-- reserved (0 .. p_amount): less than requested when the pool is nearly exhausted (concurrency-safe),
-- 0 when no budget/day-row exists. Idempotent: a second call for the same position returns the original
-- grant without reserving again (so a retry/replay never double-spends).
create or replace function public.fn_pool_reserve(p_site uuid, p_day date, p_position uuid, p_amount bigint)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_amount bigint; v_paid bigint; v_reserved bigint; v_avail bigint; v_existing bigint; v_grant bigint;
begin
  if p_amount is null or p_amount <= 0 then return 0; end if;
  -- idempotency: return the original grant if this position was already reserved
  select amount_cents into v_existing from public.pool_ledger
    where position_id = p_position and kind = 'reserve' order by id limit 1;
  if found then return v_existing; end if;
  -- lock the day's budget row; no row => no budget set => no wins
  select amount_cents, paid_cents, reserved_cents into v_amount, v_paid, v_reserved
    from public.withdrawal_pool where site_id = p_site and trade_day = p_day for update;
  if not found then return 0; end if;
  v_avail := v_amount - v_paid - v_reserved;
  if v_avail <= 0 then return 0; end if;
  v_grant := least(p_amount, v_avail);                 -- never over-reserve (hard cap)
  update public.withdrawal_pool set reserved_cents = reserved_cents + v_grant, updated_at = now()
    where site_id = p_site and trade_day = p_day;
  insert into public.pool_ledger(site_id, trade_day, position_id, kind, amount_cents)
    values (p_site, p_day, p_position, 'reserve', v_grant);
  return v_grant;
end $fn$;

-- Commit a position's outstanding reservation: reserved -> paid (the win is settled & credited).
-- Idempotent: a position with nothing outstanding (already committed/released) is a no-op returning 0.
create or replace function public.fn_pool_commit(p_position uuid)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_out bigint; v_site uuid; v_day date;
begin
  select site_id, trade_day into v_site, v_day from public.pool_ledger
    where position_id = p_position and kind = 'reserve' order by id limit 1;
  if not found then return 0; end if;
  -- lock the pool row, then recompute outstanding under the lock (race-safe)
  perform 1 from public.withdrawal_pool where site_id = v_site and trade_day = v_day for update;
  v_out := public.fn_pool_outstanding(p_position);
  if v_out <= 0 then return 0; end if;
  update public.withdrawal_pool
     set reserved_cents = reserved_cents - v_out, paid_cents = paid_cents + v_out, updated_at = now()
   where site_id = v_site and trade_day = v_day;
  insert into public.pool_ledger(site_id, trade_day, position_id, kind, amount_cents)
    values (v_site, v_day, p_position, 'commit', v_out);
  return v_out;
end $fn$;

-- Release a position's outstanding reservation back to available (a decided win that did not pay out:
-- void/refund/clamped-to-loss). Idempotent no-op when nothing outstanding.
create or replace function public.fn_pool_release(p_position uuid)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_out bigint; v_site uuid; v_day date;
begin
  select site_id, trade_day into v_site, v_day from public.pool_ledger
    where position_id = p_position and kind = 'reserve' order by id limit 1;
  if not found then return 0; end if;
  perform 1 from public.withdrawal_pool where site_id = v_site and trade_day = v_day for update;
  v_out := public.fn_pool_outstanding(p_position);
  if v_out <= 0 then return 0; end if;
  update public.withdrawal_pool set reserved_cents = reserved_cents - v_out, updated_at = now()
   where site_id = v_site and trade_day = v_day;
  insert into public.pool_ledger(site_id, trade_day, position_id, kind, amount_cents)
    values (v_site, v_day, p_position, 'release', v_out);
  return v_out;
end $fn$;

do $g$
begin
  revoke all on function public.fn_pool_outstanding(uuid)                 from public, anon, authenticated;
  revoke all on function public.fn_pool_reserve(uuid,date,uuid,bigint)    from public, anon, authenticated;
  revoke all on function public.fn_pool_commit(uuid)                      from public, anon, authenticated;
  revoke all on function public.fn_pool_release(uuid)                     from public, anon, authenticated;
  grant execute on function public.fn_pool_outstanding(uuid)              to service_role;
  grant execute on function public.fn_pool_reserve(uuid,date,uuid,bigint) to service_role;
  grant execute on function public.fn_pool_commit(uuid)                   to service_role;
  grant execute on function public.fn_pool_release(uuid)                  to service_role;
end $g$;
