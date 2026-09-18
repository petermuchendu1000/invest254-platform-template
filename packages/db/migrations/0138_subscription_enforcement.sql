-- 0138_subscription_enforcement.sql — enforce plan limits + hard-suspend via BEFORE INSERT triggers.
--
-- WHY triggers (not RPC edits): the caps + "brands go offline when suspended" must hold on EVERY
-- insert path (RPCs, onboarding, direct), and we must NOT rewrite the audited money/register RPCs.
-- BEFORE INSERT triggers are the single, centralized chokepoint. They only touch INSERTs, so
-- settlement/payout completion (UPDATEs of existing positions/transactions) is untouched — in-flight
-- trades still settle and pending withdrawals still complete when a platform is suspended.
--
-- Fail-safe by construction: fn_platform_serviceable() returns TRUE unless the subscription is
-- suspended/cancelled, and fn_plan_limits() returns NULL (unlimited) for Enterprise / no-subscription.
-- The DEFAULT platform is Enterprise/active, so the live hot path short-circuits with no count query
-- and never raises. Idempotent (create-or-replace + drop-if-exists).

-- ── Site quota + serviceability (new brands) ─────────────────────────────────────────────────────
create or replace function public.fn_enforce_site_quota() returns trigger
language plpgsql set search_path = public as $fn$
declare v_max int; v_count int;
begin
  if not public.fn_platform_serviceable(new.platform_id) then
    raise exception 'PLATFORM_SUSPENDED: this platform''s subscription is suspended/cancelled';
  end if;
  select max_sites into v_max from public.fn_plan_limits(new.platform_id);
  if v_max is not null then
    select count(*) into v_count from public.sites where platform_id = new.platform_id;
    if v_count >= v_max then
      raise exception 'SUBSCRIPTION_SITE_LIMIT: plan allows % site(s) for this platform', v_max;
    end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_enforce_site_quota on public.sites;
create trigger trg_enforce_site_quota before insert on public.sites
  for each row execute function public.fn_enforce_site_quota();

-- ── User quota + serviceability (player signups only) ────────────────────────────────────────────
-- Only PLAYER inserts are gated: staff (admin/marketer/platform_admin) are provisioned by operators
-- and must remain creatable even on a full/suspended platform to run/repair it.
create or replace function public.fn_enforce_user_quota() returns trigger
language plpgsql set search_path = public as $fn$
declare v_platform uuid; v_max int; v_count int;
begin
  if new.role is distinct from 'player' then return new; end if;
  select platform_id into v_platform from public.sites where id = new.site_id;
  if v_platform is null then return new; end if;
  if not public.fn_platform_serviceable(v_platform) then
    raise exception 'PLATFORM_SUSPENDED: registrations are closed while the subscription is suspended/cancelled';
  end if;
  select max_users into v_max from public.fn_plan_limits(v_platform);
  if v_max is not null then
    select count(*) into v_count
      from public.profiles pr join public.sites si on si.id = pr.site_id
     where si.platform_id = v_platform;
    if v_count >= v_max then
      raise exception 'SUBSCRIPTION_USER_LIMIT: plan allows % user(s) for this platform', v_max;
    end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_enforce_user_quota on public.profiles;
create trigger trg_enforce_user_quota before insert on public.profiles
  for each row execute function public.fn_enforce_user_quota();

-- ── Hard suspend: block new play + new money movement on a suspended/cancelled platform's sites ──
create or replace function public.fn_enforce_site_serviceable() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if not public.fn_site_serviceable(new.site_id) then
    raise exception 'PLATFORM_SUSPENDED: this brand is offline (subscription suspended/cancelled)';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_positions_serviceable on public.positions;
create trigger trg_positions_serviceable before insert on public.positions
  for each row execute function public.fn_enforce_site_serviceable();
drop trigger if exists trg_transactions_serviceable on public.transactions;
create trigger trg_transactions_serviceable before insert on public.transactions
  for each row execute function public.fn_enforce_site_serviceable();
