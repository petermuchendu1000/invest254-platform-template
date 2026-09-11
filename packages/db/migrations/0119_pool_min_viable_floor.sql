-- 0119_pool_min_viable_floor.sql — defense-in-depth safety valve (docs/25 §15.7, BUGLOG #12).
--
-- WHY: a pool-mode brand's daily withdrawal pool is auto-seeded from sites.default_daily_pool_cents
-- (migration 0064). If that default is mis-set, zero, or starved to ~nothing by a demand-collapse in
-- the allocator (the #12 incident), EVERY payout gate in the controller — the cash fuse
-- `available = amount − paid − reserved` AND the per-player no-scoop share `playerShare × amount`
-- (packages/shared/src/pool.ts) — collapses with `amount`, so every decided win clamps to a loss and
-- players lose 100% SILENTLY. This valve makes that impossible: a pool-mode brand's day is always
-- seeded to at least the MIN VIABLE amount — enough for a single maximum-multiplier win at the
-- minimum stake to clear the no-scoop share — so the engine can always fund real wins.
--
-- MONEY-SAFE (does NOT dent the house edge): withdrawal_pool.amount is only a CEILING/fuse. The
-- controller independently caps realized payout at `paid + reserved ≤ ⌊targetRtp × turnover⌋`
-- (the RTP-budget invariant, docs/25 §14), so a larger seed can never overpay — realized RTP stays
-- ≤ 1 − house_edge on any volume. The valve only removes the false 100%-loss floor, it never raises payout.
--
-- SCOPE: only pool_mode brands are floored; statistical brands and idle brands (a day with no trade
-- never calls this function, so no row is created) are untouched. An explicit
-- fn_admin_set_withdrawal_pool for the day still wins (ON CONFLICT DO NOTHING preserves it). The
-- playerShare divisor (0.15) mirrors DEFAULT_POOL_KNOBS.playerShare (packages/shared/src/pool.ts); it
-- is a conservative lower bound, not a live copy — if that knob is lowered the floor stays safe (higher).
-- Additive + idempotent (CREATE OR REPLACE); EAT-day semantics unchanged.

create or replace function public.fn_pool_ensure_day(p_site uuid, p_day date)
returns public.withdrawal_pool
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.withdrawal_pool; v_seed bigint;
begin
  -- seed = brand default, floored (pool-mode only) at min-viable = ⌈min_stake × max_multiplier ÷ 0.15⌉
  select greatest(
           coalesce(s.default_daily_pool_cents, 0),
           case when s.pool_mode
                then ceil( coalesce(g.min_stake, 0)::numeric
                           * greatest(coalesce(g.max_multiplier, 1)::numeric, 1)
                           / 0.15 )::bigint
                else 0 end
         )
    into v_seed
    from public.sites s
    left join public.site_game_config g on g.site_id = s.id
   where s.id = p_site;

  insert into public.withdrawal_pool (site_id, trade_day, amount_cents)
    values (p_site, p_day, coalesce(v_seed, 0))
  on conflict (site_id, trade_day) do nothing;   -- an explicit per-day set wins; idempotent re-call

  select * into v_row from public.withdrawal_pool where site_id = p_site and trade_day = p_day;
  return v_row;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_pool_ensure_day(uuid,date) from public, anon, authenticated;
  grant execute on function public.fn_pool_ensure_day(uuid,date) to service_role;
end
$g$;
