-- 0136_subscription_plans.sql — subscription plans + per-platform subscriptions (Issue 2).
--
-- A subscription attaches to a PLATFORM (the tenant unit from Issue 1). It caps how many sites and
-- users a platform may have and carries a lifecycle status. Enforcement (blocking over-limit + the
-- "hard suspend") lives in 0137; this migration is the model + governance RPCs + read helpers.
--
-- Safe for the live DB: additive + idempotent. The DEFAULT platform (all 11 live brands + ~2,000
-- users) is seeded to ENTERPRISE / active (unlimited) so no existing insert path can ever trip a
-- limit. New platforms auto-receive a Trial/Starter subscription via a trigger.

-- ── 1. Plan catalog ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.subscription_plans (
  key            text primary key,
  name           text not null,
  max_sites      int,                       -- null = unlimited
  max_users      int,                       -- null = unlimited
  price_cents    bigint,                     -- null = custom (quoted per deal)
  currency       text not null default 'KES',
  billing_period text not null default 'month' check (billing_period in ('month','year')),
  is_custom      boolean not null default false,
  sort           int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
insert into public.subscription_plans (key, name, max_sites, max_users, price_cents, currency, billing_period, is_custom, sort) values
  ('starter',    'Starter',    1,    100,  100000,  'KES', 'month', false, 1),   -- KES 1,000/mo
  ('business',   'Business',   5,    1000, 4000000, 'KES', 'month', false, 2),   -- KES 40,000/mo
  ('enterprise', 'Enterprise', null, null, null,    'KES', 'month', true,  3)    -- unlimited, custom
on conflict (key) do update set
  name=excluded.name, max_sites=excluded.max_sites, max_users=excluded.max_users,
  price_cents=excluded.price_cents, currency=excluded.currency, billing_period=excluded.billing_period,
  is_custom=excluded.is_custom, sort=excluded.sort, updated_at=now();

-- ── 2. Ops config (singleton) — subscription lifecycle durations + ticket escalation SLAs ────────
--     Config-driven so timings are tuned with an UPDATE, never a migration.
create table if not exists public.ops_config (
  id                       boolean primary key default true check (id),        -- single-row guard
  sub_trial_days           int not null default 14,
  sub_past_due_days        int not null default 7,   -- Past Due window before Grace
  sub_grace_days           int not null default 7,   -- Grace window before Suspended
  ticket_sla_low_mins      int not null default 4320, -- 72h
  ticket_sla_medium_mins   int not null default 1440, -- 24h
  ticket_sla_high_mins     int not null default 240,  -- 4h
  ticket_sla_critical_mins int not null default 60,   -- 1h
  updated_at               timestamptz not null default now()
);
insert into public.ops_config (id) values (true) on conflict (id) do nothing;

-- ── 3. Per-platform subscription ─────────────────────────────────────────────────────────────────
create table if not exists public.platform_subscriptions (
  platform_id          uuid primary key references public.platforms(id) on delete cascade,
  plan_key             text not null references public.subscription_plans(key),
  status               text not null default 'trial'
                         check (status in ('trial','active','past_due','grace_period','suspended','cancelled')),
  trial_ends_at        timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,          -- next due date
  grace_ends_at        timestamptz,
  custom_price_cents   bigint,               -- enterprise / negotiated
  custom_max_sites     int,                  -- overrides plan.max_sites when set
  custom_max_users     int,                  -- overrides plan.max_users when set
  last_payment_at      timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── 4. Subscription event history (audit of every status/plan/payment change) ────────────────────
create table if not exists public.subscription_events (
  id           bigserial primary key,
  platform_id  uuid not null references public.platforms(id) on delete cascade,
  from_status  text,
  to_status    text,
  plan_key     text,
  reason       text not null,               -- created|plan_change|payment|trial_expired|past_due|grace|suspended|reactivated|cancelled
  amount_cents bigint,
  actor_id     uuid,                         -- null = system / automatic transition
  actor_role   text,
  detail       jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index if not exists idx_subscription_events_platform on public.subscription_events(platform_id, created_at desc);

-- ── 5. Read helpers ──────────────────────────────────────────────────────────────────────────────
-- Effective limits (custom overrides win; null = unlimited). No subscription row -> unlimited (safe).
create or replace function public.fn_plan_limits(p_platform uuid)
returns table(max_sites int, max_users int)
language sql stable set search_path = public as $$
  select coalesce(s.custom_max_sites, p.max_sites), coalesce(s.custom_max_users, p.max_users)
    from public.platform_subscriptions s join public.subscription_plans p on p.key = s.plan_key
   where s.platform_id = p_platform
$$;

-- A platform is serviceable to PLAYERS unless its subscription is suspended/cancelled (0137 uses
-- this to take brands offline). No subscription row -> serviceable (never breaks an unsubbed tenant).
create or replace function public.fn_platform_serviceable(p_platform uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select status not in ('suspended','cancelled')
                     from public.platform_subscriptions where platform_id = p_platform), true)
$$;
create or replace function public.fn_site_serviceable(p_site uuid)
returns boolean language sql stable set search_path = public as $$
  select public.fn_platform_serviceable((select platform_id from public.sites where id = p_site))
$$;
grant execute on function public.fn_platform_serviceable(uuid) to anon, authenticated, service_role;
grant execute on function public.fn_site_serviceable(uuid) to anon, authenticated, service_role;

-- Live usage vs limits for the console + enforcement.
create or replace function public.fn_platform_usage(p_platform uuid)
returns table(plan_key text, status text, sites bigint, users bigint, max_sites int, max_users int,
              trial_ends_at timestamptz, current_period_end timestamptz, grace_ends_at timestamptz)
language sql stable set search_path = public as $$
  select s.plan_key, s.status,
         (select count(*) from public.sites si where si.platform_id = p_platform),
         (select count(*) from public.profiles pr join public.sites si on si.id = pr.site_id where si.platform_id = p_platform),
         l.max_sites, l.max_users, s.trial_ends_at, s.current_period_end, s.grace_ends_at
    from public.platform_subscriptions s
    left join lateral public.fn_plan_limits(p_platform) l on true
   where s.platform_id = p_platform
$$;

-- ── 6. Auto-provision a Trial/Starter subscription for every NEW platform ────────────────────────
create or replace function public.fn_platform_seed_subscription() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_trial int;
begin
  select sub_trial_days into v_trial from public.ops_config where id;
  insert into public.platform_subscriptions (platform_id, plan_key, status, trial_ends_at)
    values (new.id, 'starter', 'trial', now() + make_interval(days => coalesce(v_trial, 14)))
    on conflict (platform_id) do nothing;
  insert into public.subscription_events (platform_id, to_status, plan_key, reason)
    values (new.id, 'trial', 'starter', 'created');
  return new;
end;
$$;
drop trigger if exists trg_platform_seed_subscription on public.platforms;
create trigger trg_platform_seed_subscription after insert on public.platforms
  for each row execute function public.fn_platform_seed_subscription();

-- ── 7. Grandfather existing platforms: DEFAULT platform -> Enterprise/active (unlimited); any other
--       pre-existing platform (none today, but be safe) -> Enterprise/active too, so nothing breaks.
insert into public.platform_subscriptions (platform_id, plan_key, status, current_period_start)
  select id, 'enterprise', 'active', now() from public.platforms
  on conflict (platform_id) do nothing;
update public.platform_subscriptions set plan_key='enterprise', status='active'
  where platform_id = '10000000-0000-0000-0000-000000000001';
