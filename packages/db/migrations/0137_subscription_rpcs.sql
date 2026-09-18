-- 0137_subscription_rpcs.sql — governance + lifecycle RPCs for subscriptions (Issue 2).
--
-- SECURITY DEFINER, service_role. Management RPCs gate on platform_superadmin (the System owner
-- owns billing — docs/38 §1: "manage billing subscriptions" is system scope). fn_subscription_auto_
-- advance() is the un-actored cron that applies time-based transitions (Trial→Past Due→Grace→
-- Suspended) using ops_config durations. Every change writes a subscription_events row.

-- Period end for a freshly-paid/activated subscription, from the plan's billing period.
create or replace function public.fn_sub_period_end(p_plan text, p_from timestamptz)
returns timestamptz language sql stable set search_path = public as $$
  select case (select billing_period from public.subscription_plans where key = p_plan)
           when 'year' then p_from + interval '1 year' else p_from + interval '1 month' end
$$;

-- ── Assign / change a platform's plan ────────────────────────────────────────────────────────────
create or replace function public.fn_subscription_set_plan(
  p_actor uuid, p_actor_role text, p_platform uuid, p_plan text,
  p_custom_price bigint default null, p_custom_sites int default null, p_custom_users int default null
) returns public.platform_subscriptions
language plpgsql security definer set search_path = public as $fn$
declare v_row public.platform_subscriptions; v_old text; v_trial int;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.subscription_plans where key = p_plan and active) then raise exception 'PLAN_NOT_FOUND'; end if;
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  select plan_key into v_old from public.platform_subscriptions where platform_id = p_platform;
  select sub_trial_days into v_trial from public.ops_config where id;

  insert into public.platform_subscriptions (platform_id, plan_key, status, trial_ends_at, custom_price_cents, custom_max_sites, custom_max_users)
    values (p_platform, p_plan, 'trial', now() + make_interval(days => coalesce(v_trial,14)), p_custom_price, p_custom_sites, p_custom_users)
  on conflict (platform_id) do update set
    plan_key = excluded.plan_key,
    custom_price_cents = p_custom_price,
    custom_max_sites   = p_custom_sites,
    custom_max_users   = p_custom_users,
    updated_at = now()
  returning * into v_row;

  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason, actor_id, actor_role, detail)
    values (p_platform, v_row.status, v_row.status, p_plan, 'plan_change', p_actor, p_actor_role,
            jsonb_build_object('old_plan', v_old, 'new_plan', p_plan, 'custom_price', p_custom_price,
                               'custom_max_sites', p_custom_sites, 'custom_max_users', p_custom_users));
  return v_row;
end;
$fn$;

-- ── Manually set status (trial/active/past_due/grace_period/suspended/cancelled) ─────────────────
create or replace function public.fn_subscription_set_status(
  p_actor uuid, p_actor_role text, p_platform uuid, p_status text, p_reason text default null
) returns public.platform_subscriptions
language plpgsql security definer set search_path = public as $fn$
declare v_row public.platform_subscriptions; v_old text; v_grace int;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('trial','active','past_due','grace_period','suspended','cancelled') then raise exception 'INVALID_STATUS'; end if;
  select status into v_old from public.platform_subscriptions where platform_id = p_platform for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  select sub_grace_days into v_grace from public.ops_config where id;

  update public.platform_subscriptions s set
    status = p_status,
    current_period_start = case when p_status='active' then now() else s.current_period_start end,
    current_period_end   = case when p_status='active' then public.fn_sub_period_end(s.plan_key, now()) else s.current_period_end end,
    grace_ends_at        = case when p_status='grace_period' then now() + make_interval(days => coalesce(v_grace,7))
                                when p_status='active' then null else s.grace_ends_at end,
    updated_at = now()
  where s.platform_id = p_platform
  returning * into v_row;

  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason, actor_id, actor_role, detail)
    values (p_platform, v_old, p_status, v_row.plan_key, coalesce(nullif(p_reason,''),'manual_status'), p_actor, p_actor_role, '{}');
  return v_row;
end;
$fn$;

-- ── Record a payment -> Active, extend the period ────────────────────────────────────────────────
create or replace function public.fn_subscription_record_payment(
  p_actor uuid, p_actor_role text, p_platform uuid, p_amount bigint, p_period_days int default null
) returns public.platform_subscriptions
language plpgsql security definer set search_path = public as $fn$
declare v_row public.platform_subscriptions; v_old text; v_start timestamptz; v_end timestamptz;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select status into v_old from public.platform_subscriptions where platform_id = p_platform for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  v_start := now();
  select case when p_period_days is not null then v_start + make_interval(days => p_period_days)
              else public.fn_sub_period_end(s.plan_key, v_start) end
    into v_end from public.platform_subscriptions s where s.platform_id = p_platform;

  update public.platform_subscriptions s set
    status='active', current_period_start=v_start, current_period_end=v_end,
    grace_ends_at=null, last_payment_at=v_start, updated_at=now()
  where s.platform_id = p_platform returning * into v_row;

  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason, amount_cents, actor_id, actor_role, detail)
    values (p_platform, v_old, 'active', v_row.plan_key, 'payment', p_amount, p_actor, p_actor_role,
            jsonb_build_object('period_end', v_end));
  return v_row;
end;
$fn$;

-- ── Cron: apply time-based lifecycle transitions. Returns the number of subscriptions advanced. ──
create or replace function public.fn_subscription_auto_advance()
returns integer language plpgsql security definer set search_path = public as $fn$
declare v_past int; v_grace int; v_n int := 0; v_c int;
begin
  select sub_past_due_days, sub_grace_days into v_past, v_grace from public.ops_config where id;
  v_past := coalesce(v_past,7); v_grace := coalesce(v_grace,7);

  -- 1) Trial expired (unpaid) -> Past Due; stamp the due date = trial end.
  with moved as (
    update public.platform_subscriptions s set status='past_due',
           current_period_end = coalesce(s.current_period_end, s.trial_ends_at, now()), updated_at=now()
    where s.status='trial' and s.trial_ends_at is not null and s.trial_ends_at < now()
    returning s.platform_id, s.plan_key)
  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason)
    select platform_id,'trial','past_due',plan_key,'trial_expired' from moved;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 2) Active past its due date -> Past Due.
  with moved as (
    update public.platform_subscriptions s set status='past_due', updated_at=now()
    where s.status='active' and s.current_period_end is not null and s.current_period_end < now()
    returning s.platform_id, s.plan_key)
  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason)
    select platform_id,'active','past_due',plan_key,'past_due' from moved;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 3) Past Due beyond the past-due window -> Grace Period (grace clock starts now).
  with moved as (
    update public.platform_subscriptions s set status='grace_period',
           grace_ends_at = now() + make_interval(days => v_grace), updated_at=now()
    where s.status='past_due' and s.current_period_end is not null
      and now() >= s.current_period_end + make_interval(days => v_past)
    returning s.platform_id, s.plan_key)
  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason)
    select platform_id,'past_due','grace_period',plan_key,'grace' from moved;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 4) Grace expired -> Suspended (brands go offline — 0137/enforcement).
  with moved as (
    update public.platform_subscriptions s set status='suspended', updated_at=now()
    where s.status='grace_period' and s.grace_ends_at is not null and s.grace_ends_at < now()
    returning s.platform_id, s.plan_key)
  insert into public.subscription_events (platform_id, from_status, to_status, plan_key, reason)
    select platform_id,'grace_period','suspended',plan_key,'suspended' from moved;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  return v_n;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_subscription_set_plan(uuid,text,uuid,text,bigint,int,int)   from public, anon, authenticated;
  revoke all on function public.fn_subscription_set_status(uuid,text,uuid,text,text)           from public, anon, authenticated;
  revoke all on function public.fn_subscription_record_payment(uuid,text,uuid,bigint,int)      from public, anon, authenticated;
  revoke all on function public.fn_subscription_auto_advance()                                 from public, anon, authenticated;
  grant execute on function public.fn_subscription_set_plan(uuid,text,uuid,text,bigint,int,int) to service_role;
  grant execute on function public.fn_subscription_set_status(uuid,text,uuid,text,text)         to service_role;
  grant execute on function public.fn_subscription_record_payment(uuid,text,uuid,bigint,int)    to service_role;
  grant execute on function public.fn_subscription_auto_advance()                               to service_role;
end
$g$;
