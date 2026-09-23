-- 0164_pool_overview_auto.sql — POOL-1 (docs/46): per-brand pool overview + automatic distribution ON by default.
--
-- Owner request (2026-09-23): "under /pool, you must show how each brand has been distributed funds and all
-- other relevant details … set dynamic distribution on and as the default".
--
-- 1. pool_auto_settings — per platform: how each day's pool is re-split automatically. ABSENT ROW = the
--    default = 'dynamic' (demand-based water-fill, docs/25 §15) over the platform's CURRENT total (the sum of
--    its brands' daily defaults) unless a daily total is set. 'equal' splits the total evenly; 'off' leaves
--    budgets as set by hand. The daily job (scripts/pool_distribute_daily.mts) reads this for every platform.
-- 2. platform_pool_distributions.source — how a distribution was made (manual / dynamic / auto), so the
--    history can say it (dynamic runs used to look identical to manual per-brand edits).
-- 3. fn_pool_overview — one row per active brand in scope with today's budget, paid, reserved, available,
--    the recurring default, pool mode, the kill switch, pending withdrawals and 7-day payouts. A platform admin
--    sees only its own platform; the System owner any platform, or all of them.
-- Service-role only. Additive + idempotent.

create table if not exists public.pool_auto_settings (
  platform_id       uuid primary key references public.platforms(id) on delete cascade,
  mode              text not null default 'dynamic' check (mode in ('dynamic','equal','off')),
  daily_total_cents bigint check (daily_total_cents is null or daily_total_cents >= 0),
  lookback_days     int not null default 14 check (lookback_days between 3 and 90),
  last_run_at       timestamptz,
  last_run_ok       boolean,
  last_run_message  text,
  updated_by        uuid references public.profiles(id),
  updated_at        timestamptz not null default now()
);
alter table public.pool_auto_settings enable row level security;

alter table public.platform_pool_distributions add column if not exists source text not null default 'manual';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_pool_distributions_source_chk') then
    alter table public.platform_pool_distributions add constraint platform_pool_distributions_source_chk check (source in ('manual','dynamic','auto'));
  end if;
end $$;

-- Scope helper: may this actor act on this platform's pool? (platform admin: own; owner: any)
create or replace function public.fn_pool_scope_assert(p_actor uuid, p_actor_role text, p_platform uuid)
returns void language plpgsql stable security definer set search_path = public
as $fn$
begin
  if p_actor_role = 'platform_admin' then
    if p_platform is null or p_platform is distinct from (select pr.platform_id from public.profiles pr where pr.id = p_actor) then
      raise exception 'PLATFORM_SCOPE_FORBIDDEN';
    end if;
  elsif p_actor_role <> 'platform_superadmin' then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_platform is not null and not exists (select 1 from public.platforms where id = p_platform) then
    raise exception 'PLATFORM_NOT_FOUND';
  end if;
end;
$fn$;

create or replace function public.fn_pool_auto_settings_get(p_actor uuid, p_actor_role text, p_platform uuid)
returns table(platform_id uuid, mode text, daily_total_cents bigint, lookback_days int, is_default boolean,
              last_run_at timestamptz, last_run_ok boolean, last_run_message text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public
as $fn$
begin
  if p_platform is null then raise exception 'PLATFORM_REQUIRED'; end if;
  perform public.fn_pool_scope_assert(p_actor, p_actor_role, p_platform);
  return query
    select p_platform, coalesce(s.mode, 'dynamic'), s.daily_total_cents, coalesce(s.lookback_days, 14), (s.platform_id is null or s.updated_by is null),
           s.last_run_at, s.last_run_ok, s.last_run_message, s.updated_at
      from (select 1) one left join public.pool_auto_settings s on s.platform_id = p_platform;
end;
$fn$;

create or replace function public.fn_pool_auto_settings_set(p_actor uuid, p_actor_role text, p_platform uuid,
  p_mode text, p_daily_total_cents bigint, p_lookback_days int)
returns void language plpgsql security definer set search_path = public
as $fn$
begin
  if p_platform is null then raise exception 'PLATFORM_REQUIRED'; end if;
  perform public.fn_pool_scope_assert(p_actor, p_actor_role, p_platform);
  if p_mode not in ('dynamic','equal','off') then raise exception 'INVALID_MODE'; end if;
  if p_daily_total_cents is not null and p_daily_total_cents < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_mode = 'equal' and p_daily_total_cents is null then raise exception 'TOTAL_REQUIRED'; end if;
  if coalesce(p_lookback_days, 14) not between 3 and 90 then raise exception 'INVALID_LOOKBACK'; end if;
  insert into public.pool_auto_settings(platform_id, mode, daily_total_cents, lookback_days, updated_by, updated_at)
    values (p_platform, p_mode, p_daily_total_cents, coalesce(p_lookback_days, 14), p_actor, now())
  on conflict (platform_id) do update set mode = excluded.mode, daily_total_cents = excluded.daily_total_cents,
    lookback_days = excluded.lookback_days, updated_by = excluded.updated_by, updated_at = now();
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'pool.auto_settings', 'platform', p_platform::text,
            jsonb_build_object('mode', p_mode, 'daily_total_cents', p_daily_total_cents, 'lookback_days', coalesce(p_lookback_days, 14)));
end;
$fn$;

-- The scheduled job's outcome, per platform (service-role only; no actor — it is the System's own run).
create or replace function public.fn_pool_auto_record_run(p_platform uuid, p_ok boolean, p_message text)
returns void language sql security definer set search_path = public
as $fn$
  insert into public.pool_auto_settings(platform_id, last_run_at, last_run_ok, last_run_message)
    values (p_platform, now(), p_ok, left(coalesce(p_message, ''), 500))
  on conflict (platform_id) do update set last_run_at = now(), last_run_ok = p_ok, last_run_message = left(coalesce(p_message, ''), 500);
$fn$;

create or replace function public.fn_pool_overview(p_actor uuid, p_actor_role text, p_platform uuid)
returns table(site_id uuid, name text, slug text, platform_id uuid, platform_name text, pool_mode boolean,
              withdrawals_enabled boolean, default_cents bigint, today_cents bigint, paid_cents bigint,
              reserved_cents bigint, available_cents bigint, today_set boolean,
              pending_count int, pending_cents bigint, paid_7d_cents bigint, last_changed_at timestamptz)
language plpgsql stable security definer set search_path = public
as $fn$
declare v_day date := public.fn_eat_day(now());
begin
  perform public.fn_pool_scope_assert(p_actor, p_actor_role, p_platform);
  -- A platform admin with no platform argument is pinned to its own platform by fn_pool_scope_assert
  -- (it raises), so p_platform null here means the System owner asked for every platform.
  return query
    select s.id, s.name, s.slug, s.platform_id, p.name, s.pool_mode, s.withdrawals_enabled,
           s.default_daily_pool_cents::bigint,
           coalesce(w.amount_cents, s.default_daily_pool_cents)::bigint,
           coalesce(w.paid_cents, 0)::bigint,
           coalesce(w.reserved_cents, 0)::bigint,
           greatest(0, coalesce(w.amount_cents, s.default_daily_pool_cents) - coalesce(w.paid_cents, 0) - coalesce(w.reserved_cents, 0))::bigint,
           w.site_id is not null,
           (select count(*)::int from public.transactions t where t.site_id = s.id and t.kind = 'withdrawal' and t.status = 'pending'),
           (select coalesce(sum(t.amount), 0)::bigint from public.transactions t where t.site_id = s.id and t.kind = 'withdrawal' and t.status = 'pending'),
           (select coalesce(sum(t.amount), 0)::bigint from public.transactions t
              where t.site_id = s.id and t.kind = 'withdrawal' and t.status = 'success' and t.updated_at > now() - interval '7 days'),
           w.updated_at
      from public.sites s
      left join public.platforms p on p.id = s.platform_id
      left join public.withdrawal_pool w on w.site_id = s.id and w.trade_day = v_day
     where s.status = 'active' and (p_platform is null or s.platform_id = p_platform)
     order by p.name nulls last, s.name;
end;
$fn$;

revoke all on function public.fn_pool_scope_assert(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.fn_pool_auto_settings_get(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.fn_pool_auto_settings_set(uuid, text, uuid, text, bigint, int) from public, anon, authenticated;
revoke all on function public.fn_pool_auto_record_run(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.fn_pool_overview(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_pool_scope_assert(uuid, text, uuid) to service_role;
grant execute on function public.fn_pool_auto_settings_get(uuid, text, uuid) to service_role;
grant execute on function public.fn_pool_auto_settings_set(uuid, text, uuid, text, bigint, int) to service_role;
grant execute on function public.fn_pool_auto_record_run(uuid, boolean, text) to service_role;
grant execute on function public.fn_pool_overview(uuid, text, uuid) to service_role;
