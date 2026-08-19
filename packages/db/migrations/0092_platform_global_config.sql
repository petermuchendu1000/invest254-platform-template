-- 0092_platform_global_config.sql — platform-wide master controls ("one console controls every client").
--
-- The platform_superadmin gets a single source of truth that OVERRIDES all brands:
--   * master system kill-switches (deposits / withdrawals / play / marketers / registrations),
--   * an optional platform-wide maintenance banner,
--   * a global withdrawal-pool distributor that fans a total across every active brand's daily pool
--     cap (sites.default_daily_pool_cents — a CONFIG cap, not a wallet transfer; reuses the proven
--     fn_admin_set_default_pool path), fully audited.
-- Defaults are all-ON so this migration is behaviour-neutral until the console flips something.
-- Enforcement of the switches lives in the engine/api service layer (they LISTEN on
-- 'platform_config_changed'); this migration is the durable, versioned, audited data + RPC surface.
-- Additive, idempotent, platform_superadmin-gated. Money-neutral (sets caps + config only).

create table if not exists public.platform_global_config (
  id                       boolean     primary key default true check (id),          -- singleton row
  deposits_enabled         boolean     not null default true,
  withdrawals_enabled      boolean     not null default true,
  play_enabled             boolean     not null default true,
  marketers_enabled        boolean     not null default true,
  registrations_enabled    boolean     not null default true,
  maintenance_message      text,
  global_daily_pool_cents  bigint,                                                    -- last distributed total (null = never)
  version                  int         not null default 1,
  updated_by               uuid,
  updated_at               timestamptz not null default now()
);
insert into public.platform_global_config(id) values (true) on conflict (id) do nothing;

create table if not exists public.platform_global_config_versions (
  version    int primary key,
  snapshot   jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table if not exists public.platform_pool_distributions (
  id             bigint generated always as identity primary key,
  total_cents    bigint      not null,
  mode           text        not null,
  site_count     int         not null,
  per_site       jsonb       not null,
  distributed_by uuid,
  created_at     timestamptz not null default now()
);

-- ── read ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_platform_get_global_config()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select to_jsonb(g) from public.platform_global_config g where g.id;
$fn$;

-- ── set master switches / banner (platform owner only; versioned + audited + notify) ───────────────
create or replace function public.fn_platform_set_global_config(p_actor uuid, p_actor_role text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare g public.platform_global_config; v_site uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  -- admin_actions.site_id is NOT NULL; anchor platform-level rows to the default (first) site.
  select id into v_site from public.sites order by created_at limit 1;
  update public.platform_global_config set
    deposits_enabled      = coalesce((p_patch->>'deposits_enabled')::boolean,      deposits_enabled),
    withdrawals_enabled   = coalesce((p_patch->>'withdrawals_enabled')::boolean,   withdrawals_enabled),
    play_enabled          = coalesce((p_patch->>'play_enabled')::boolean,          play_enabled),
    marketers_enabled     = coalesce((p_patch->>'marketers_enabled')::boolean,     marketers_enabled),
    registrations_enabled = coalesce((p_patch->>'registrations_enabled')::boolean, registrations_enabled),
    maintenance_message   = case when p_patch ? 'maintenance_message'
                                 then nullif(p_patch->>'maintenance_message','') else maintenance_message end,
    version    = version + 1,
    updated_by = p_actor,
    updated_at = now()
  where id returning * into g;
  insert into public.platform_global_config_versions(version, snapshot, changed_by)
    values (g.version, to_jsonb(g), p_actor);
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.global_config.set', 'platform', 'global', p_patch, v_site);
  perform pg_notify('platform_config_changed', g.version::text);
  return to_jsonb(g);
end;
$fn$;

-- ── distribute a global withdrawal-pool total across every ACTIVE brand's daily cap ────────────────
--   mode 'equal'  → floor(total/n) each, remainder to the first site (deterministic by created_at).
--   mode 'per_site' with p_overrides {site_id: cents} → exact per-site amounts (missing sites untouched).
create or replace function public.fn_platform_distribute_pool(
  p_actor uuid, p_actor_role text, p_total_cents bigint,
  p_mode text default 'equal', p_overrides jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare n int; base bigint; rem bigint; per jsonb := '{}'::jsonb; s record; amt bigint; i int := 0; total_applied bigint := 0;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_mode not in ('equal','per_site') then raise exception 'INVALID_MODE'; end if;
  if p_mode = 'equal' and (p_total_cents is null or p_total_cents < 0) then raise exception 'INVALID_AMOUNT'; end if;

  select count(*) into n from public.sites where status = 'active';
  if n = 0 then raise exception 'NO_ACTIVE_SITES'; end if;
  base := case when p_mode='equal' then p_total_cents / n else 0 end;
  rem  := case when p_mode='equal' then p_total_cents - base * n else 0 end;

  for s in select id from public.sites where status = 'active' order by created_at loop
    if p_mode = 'equal' then
      amt := base + (case when i = 0 then rem else 0 end);
    else
      amt := coalesce((p_overrides->>s.id::text)::bigint, null);
      if amt is null then i := i + 1; continue; end if;   -- per_site: skip sites not named
      if amt < 0 then raise exception 'INVALID_AMOUNT'; end if;
    end if;
    update public.sites set default_daily_pool_cents = amt where id = s.id;
    per := per || jsonb_build_object(s.id::text, amt);
    total_applied := total_applied + amt;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'platform.pool.distribute', 'site', s.id::text,
              jsonb_build_object('default_daily_pool_cents', amt, 'mode', p_mode), s.id);
    i := i + 1;
  end loop;

  insert into public.platform_pool_distributions(total_cents, mode, site_count, per_site, distributed_by)
    values (coalesce(p_total_cents, total_applied), p_mode, (select count(*)::int from jsonb_object_keys(per)), per, p_actor);
  update public.platform_global_config set global_daily_pool_cents = coalesce(p_total_cents, total_applied),
    updated_by = p_actor, updated_at = now() where id;
  perform pg_notify('platform_config_changed', 'pool');
  return jsonb_build_object('total_cents', coalesce(p_total_cents, total_applied), 'mode', p_mode, 'per_site', per);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_platform_get_global_config()                                from public, anon, authenticated;
  revoke all on function public.fn_platform_set_global_config(uuid,text,jsonb)                  from public, anon, authenticated;
  revoke all on function public.fn_platform_distribute_pool(uuid,text,bigint,text,jsonb)        from public, anon, authenticated;
  grant execute on function public.fn_platform_get_global_config()                               to service_role;
  grant execute on function public.fn_platform_set_global_config(uuid,text,jsonb)                to service_role;
  grant execute on function public.fn_platform_distribute_pool(uuid,text,bigint,text,jsonb)      to service_role;
  grant select, insert, update on public.platform_global_config          to service_role;
  grant select, insert          on public.platform_global_config_versions to service_role;
  grant select, insert          on public.platform_pool_distributions     to service_role;
end $g$;
