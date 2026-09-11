-- 0118_pool_realtime_topup.sql — real-time (intra-day) withdrawal-pool reallocation (docs/25 §15.1).
--
-- WHY: the daily distributor (0092 + scripts/pool_distribute_daily) sets each brand's budget once, at
-- the EAT-day start, into sites.default_daily_pool_cents (which fn_pool_ensure_day seeds into that
-- day's withdrawal_pool.amount_cents). It cannot react WITHIN the day. This RPC lets the engine move
-- the platform's UNDISTRIBUTED reserve onto whichever brands are under-served RIGHT NOW (triggered by
-- confirmed deposits), so a brand seeing live demand gets more payout budget the same day.
--
-- NEVER-CLAWBACK (money-safe by construction): this only ever RAISES today's amount_cents via
-- greatest(current, requested). A brand's budget can never be reduced below what it already holds, so
-- the withdrawal_pool hard invariant (amount_cents >= paid_cents + reserved_cents, migration 0062) is
-- always preserved and no in-flight decided-win can be stranded. The caller (engine) computes the new
-- amounts by progressive-filling the reserve toward the water-fill ideal (packages/shared
-- pooldistribution.ts), so Σ amount stays within the operator's global envelope.
--
-- Platform-superadmin gated, SECURITY DEFINER, service-role only. Audited (admin_actions, per site,
-- matching 0092) + pg_notify('platform_config_changed','pool'). Idempotent: re-applying the same or a
-- lower amount is a no-op (greatest keeps the current value). Additive + revertible.

create or replace function public.fn_pool_topup_today(
  p_actor uuid, p_actor_role text, p_grants jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_day    date := public.fn_eat_day();
  g        record;
  v_applied bigint;
  per      jsonb := '{}'::jsonb;
  n        int := 0;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_grants is null or jsonb_typeof(p_grants) <> 'array' then raise exception 'INVALID_GRANTS'; end if;

  for g in
    select (e->>'site_id')::uuid as site_id, (e->>'amount_cents')::bigint as amount
      from jsonb_array_elements(p_grants) e
  loop
    if g.site_id is null then continue; end if;
    if g.amount is null or g.amount < 0 then raise exception 'INVALID_AMOUNT'; end if;

    -- Ensure today's pool row exists (seeds from default_daily_pool_cents when absent), then raise it.
    perform public.fn_pool_ensure_day(g.site_id, v_day);
    update public.withdrawal_pool
       set amount_cents = greatest(amount_cents, g.amount), updated_at = now()
     where site_id = g.site_id and trade_day = v_day
     returning amount_cents into v_applied;

    if found then
      per := per || jsonb_build_object(g.site_id::text, v_applied);
      n := n + 1;
      insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
        values (p_actor, p_actor_role, 'platform.pool.realtime_topup', 'site', g.site_id::text,
                jsonb_build_object('eat_day', v_day, 'amount_cents', v_applied, 'requested_cents', g.amount), g.site_id);
    end if;
  end loop;

  if n > 0 then
    perform pg_notify('platform_config_changed', 'pool');
  end if;
  return jsonb_build_object('eat_day', v_day, 'per_site', per, 'sites', n);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_pool_topup_today(uuid, text, jsonb) from public, anon, authenticated;
  grant execute on function public.fn_pool_topup_today(uuid, text, jsonb) to service_role;
end
$g$;
