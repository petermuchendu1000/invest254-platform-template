-- 0064_default_daily_pool.sql — auto-seed each EAT day's withdrawal pool from a per-brand default,
-- so the operator sets it ONCE and every new day is funded automatically (no cron, no rotating secret).
-- Without this, a day with no explicitly-set pool row pays nobody -> every player loses 100% that day.
-- Additive + idempotent.

-- Per-brand recurring daily budget. 0 = no auto budget (that day pays nothing unless set explicitly).
alter table public.sites add column if not exists default_daily_pool_cents bigint not null default 0
  check (default_daily_pool_cents >= 0);

-- Ensure today's (EAT) withdrawal_pool row exists, seeded from the brand default. Idempotent: returns
-- the existing row if already set (an explicit fn_admin_set_withdrawal_pool for the day wins). Called by
-- the engine on every pool read, so the first trade of a new day funds the day automatically.
create or replace function public.fn_pool_ensure_day(p_site uuid, p_day date)
returns public.withdrawal_pool
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.withdrawal_pool;
begin
  insert into public.withdrawal_pool (site_id, trade_day, amount_cents)
    select p_site, p_day, coalesce(s.default_daily_pool_cents, 0) from public.sites s where s.id = p_site
  on conflict (site_id, trade_day) do nothing;
  select * into v_row from public.withdrawal_pool where site_id = p_site and trade_day = p_day;
  return v_row;
end;
$fn$;

-- Superadmin sets a brand's recurring default (audited). Applies from the NEXT day's auto-seed (and
-- today only if today's row hasn't been created yet).
create or replace function public.fn_admin_set_default_pool(p_actor uuid, p_actor_role text, p_site uuid, p_amount bigint)
returns bigint
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  update public.sites set default_daily_pool_cents = p_amount where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool.default.set', 'site', p_site::text,
            jsonb_build_object('default_daily_pool_cents', p_amount), p_site);
  return p_amount;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_pool_ensure_day(uuid,date)                     from public, anon, authenticated;
  revoke all on function public.fn_admin_set_default_pool(uuid,text,uuid,bigint)  from public, anon, authenticated;
  grant execute on function public.fn_pool_ensure_day(uuid,date)                    to service_role;
  grant execute on function public.fn_admin_set_default_pool(uuid,text,uuid,bigint) to service_role;
end
$g$;
