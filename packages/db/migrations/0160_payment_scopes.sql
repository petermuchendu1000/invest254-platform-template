-- 0160_payment_scopes.sql — PAY-1 (docs/43): per-platform and per-brand payment-gateway accounts.
--
-- Owner decision 2026-09-23: platform admins configure M-Pesa / any gateway for their whole platform or
-- for one brand, and LIVE payments honour it. Model (docs/43 §2): a brand's money flows through ONE
-- "payment owner" — its own scope if active, else its platform's scope if active, else the System
-- (global). Configs of a non-global scope are drafts until that scope is explicitly activated.
--
-- This migration adds the storage + authorization layer; the engine enforces the money invariants
-- (no mixing across owners, payouts follow the owner, verification uses the initiating scope).
-- Additive + idempotent. Existing global behaviour is unchanged: no scope is active after this runs.

-- ── 1. platform-level config rows + one-scope-per-row ────────────────────────────────────────────
alter table public.payment_provider_config
  add column if not exists platform_id uuid null references public.platforms(id) on delete cascade;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_provider_config_one_scope') then
    alter table public.payment_provider_config
      add constraint ck_provider_config_one_scope check (site_id is null or platform_id is null);
  end if;
end
$c$;

-- The "global" row is now the one with NEITHER a site nor a platform.
drop index if exists public.uq_provider_config_global;
create unique index uq_provider_config_global
  on public.payment_provider_config(provider_code) where site_id is null and platform_id is null;
create unique index if not exists uq_provider_config_platform
  on public.payment_provider_config(provider_code, platform_id) where platform_id is not null;

-- ── 2. which non-global scopes are LIVE ──────────────────────────────────────────────────────────
create table if not exists public.payment_scopes (
  scope_type      text        not null check (scope_type in ('platform', 'site')),
  scope_id        uuid        not null,
  active          boolean     not null default false,
  payouts_enabled boolean     not null default true,   -- false = "deposits only" was explicitly accepted
  activated_by    uuid        null references public.profiles(id),
  activated_at    timestamptz null,
  updated_at      timestamptz not null default now(),
  primary key (scope_type, scope_id)
);
alter table public.payment_scopes enable row level security;

-- ── 3. the scope a provider transaction was initiated / paid under (verification uses it) ────────
alter table public.transactions add column if not exists payment_scope text null;
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_transactions_payment_scope') then
    alter table public.transactions add constraint ck_transactions_payment_scope check (
      payment_scope is null or payment_scope = 'global'
      or payment_scope ~ '^(platform|site):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  end if;
end
$c$;

-- ── 4. keep the legacy (global/site) RPCs blind to platform rows ────────────────────────────────
create or replace function public.fn_admin_get_provider_config(
  p_actor_role text, p_code text, p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.payment_provider_config;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  select * into v from public.payment_provider_config
   where provider_code = p_code and site_id is not distinct from p_site and platform_id is null;
  if not found then
    return jsonb_build_object(
      'provider_code', p_code, 'site_id', p_site,
      'settings', '{}'::jsonb, 'secret_meta', '{}'::jsonb,
      'has_secret', false, 'enc_version', 1, 'updated_at', null, 'exists', false);
  end if;
  return jsonb_build_object(
    'provider_code', v.provider_code, 'site_id', v.site_id,
    'settings', v.settings, 'secret_meta', v.secret_meta,
    'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

create or replace function public.fn_platform_set_provider_config(
  p_actor uuid, p_actor_role text, p_code text, p_site uuid,
  p_settings jsonb, p_secret_ciphertext text, p_secret_meta jsonb, p_enc_version int)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.payment_provider_config; v_audit_site uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  if p_site is not null and not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;

  select * into v from public.payment_provider_config
   where provider_code = p_code and site_id is not distinct from p_site and platform_id is null;

  if found then
    update public.payment_provider_config
       set settings          = coalesce(p_settings, settings),
           secret_ciphertext = case
                                  when p_secret_ciphertext is null then secret_ciphertext
                                  when p_secret_ciphertext = ''    then null
                                  else p_secret_ciphertext end,
           secret_meta       = case
                                  when p_secret_ciphertext is null then secret_meta
                                  when p_secret_ciphertext = ''    then '{}'::jsonb
                                  else coalesce(p_secret_meta, '{}'::jsonb) end,
           enc_version       = coalesce(p_enc_version, enc_version),
           updated_by        = p_actor,
           updated_at        = now()
     where provider_code = p_code and site_id is not distinct from p_site and platform_id is null
     returning * into v;
  else
    insert into public.payment_provider_config(
      provider_code, site_id, settings, secret_ciphertext, secret_meta, enc_version, updated_by)
    values (
      p_code, p_site, coalesce(p_settings, '{}'::jsonb),
      case when p_secret_ciphertext in ('', null) then null else p_secret_ciphertext end,
      case when p_secret_ciphertext is null or p_secret_ciphertext = '' then '{}'::jsonb else coalesce(p_secret_meta,'{}'::jsonb) end,
      coalesce(p_enc_version, 1), p_actor)
    returning * into v;
  end if;

  select id into v_audit_site from public.sites order by created_at limit 1;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.config', 'payment_provider', p_code,
            jsonb_build_object(
              'site_id', p_site,
              'settings_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(coalesce(p_settings,'{}'::jsonb)) k),
              'secret_action', case when p_secret_ciphertext is null then 'unchanged'
                                    when p_secret_ciphertext = '' then 'cleared' else 'updated' end),
            coalesce(p_site, v_audit_site, '00000000-0000-0000-0000-000000000001'::uuid));
  perform pg_notify('payment_providers_changed', p_code);

  return jsonb_build_object(
    'provider_code', v.provider_code, 'site_id', v.site_id,
    'settings', v.settings, 'secret_meta', v.secret_meta,
    'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

create or replace function public.fn_provider_config_resolve(p_code text, p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.payment_provider_config;
begin
  if p_site is not null then
    select * into v from public.payment_provider_config where provider_code = p_code and site_id = p_site;
    if found then
      return jsonb_build_object('provider_code', v.provider_code, 'site_id', v.site_id,
        'settings', v.settings, 'secret_ciphertext', v.secret_ciphertext, 'enc_version', v.enc_version, 'scope', 'site');
    end if;
  end if;
  select * into v from public.payment_provider_config
   where provider_code = p_code and site_id is null and platform_id is null;
  if not found then return null; end if;
  return jsonb_build_object('provider_code', v.provider_code, 'site_id', null,
    'settings', v.settings, 'secret_ciphertext', v.secret_ciphertext, 'enc_version', v.enc_version, 'scope', 'global');
end;
$fn$;

-- ── 5. scope authorization ───────────────────────────────────────────────────────────────────────
-- The platform a (platform|site) scope belongs to; raises SCOPE_NOT_FOUND for an unknown target.
create or replace function public.fn_payment_scope_platform(p_scope_type text, p_scope_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $fn$
declare v uuid;
begin
  if p_scope_type = 'platform' then
    select id into v from public.platforms where id = p_scope_id;
  elsif p_scope_type = 'site' then
    select platform_id into v from public.sites where id = p_scope_id;
  else
    raise exception 'INVALID_SCOPE';
  end if;
  if v is null then raise exception 'SCOPE_NOT_FOUND'; end if;
  return v;
end;
$fn$;

-- System owner: any scope. Platform admin: its own platform and that platform's brands. Else refused.
create or replace function public.fn_payment_scope_assert(p_actor uuid, p_actor_role text, p_scope_type text, p_scope_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $fn$
declare v_platform uuid; v_actor_platform uuid;
begin
  v_platform := public.fn_payment_scope_platform(p_scope_type, p_scope_id);
  if p_actor_role = 'platform_superadmin' then return v_platform; end if;
  if p_actor_role <> 'platform_admin' then raise exception 'NOT_AUTHORIZED'; end if;
  select platform_id into v_actor_platform from public.profiles where id = p_actor and role = 'platform_admin';
  if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
  if v_actor_platform <> v_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  return v_platform;
end;
$fn$;

-- A site to attribute a scope's audit rows to (admin_actions.site_id is NOT NULL; F-45 attribution).
create or replace function public.fn_payment_scope_audit_site(p_scope_type text, p_scope_id uuid)
returns uuid language sql stable security definer set search_path = public as $fn$
  select case when p_scope_type = 'site' then p_scope_id
         else coalesce((select s.id from public.sites s where s.platform_id = p_scope_id order by s.created_at limit 1),
                       '00000000-0000-0000-0000-000000000001'::uuid) end;
$fn$;

-- Settings a platform admin may never set (docs/43 §3.4): where we talk to / listen from, sandbox mode.
create or replace function public.fn_payment_owner_only_violation(p_actor_role text, p_settings jsonb)
returns text language plpgsql immutable as $fn$
declare k text;
begin
  if p_actor_role = 'platform_superadmin' or p_settings is null then return null; end if;
  foreach k in array array['api_base','base_url','callback_url','callback_allowed_cidrs','stk_callback_url','b2c_result_url','b2c_timeout_url'] loop
    if p_settings ? k and coalesce(p_settings->>k, '') <> '' then return k; end if;
  end loop;
  if coalesce(p_settings->>'env', p_settings->>'environment', 'production') not in ('production', 'live') then
    return 'env';
  end if;
  return null;
end;
$fn$;

-- ── 6. scoped config read / write / clear / resolve ─────────────────────────────────────────────
create or replace function public.fn_provider_config_get_scoped(
  p_actor uuid, p_actor_role text, p_code text, p_scope_type text, p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.payment_provider_config;
begin
  perform public.fn_payment_scope_assert(p_actor, p_actor_role, p_scope_type, p_scope_id);
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  select * into v from public.payment_provider_config
   where provider_code = p_code
     and ((p_scope_type = 'platform' and platform_id = p_scope_id) or (p_scope_type = 'site' and site_id = p_scope_id));
  if not found then
    return jsonb_build_object('provider_code', p_code, 'scope_type', p_scope_type, 'scope_id', p_scope_id,
      'settings', '{}'::jsonb, 'secret_meta', '{}'::jsonb, 'has_secret', false, 'enc_version', 1, 'updated_at', null, 'exists', false);
  end if;
  return jsonb_build_object('provider_code', v.provider_code, 'scope_type', p_scope_type, 'scope_id', p_scope_id,
    'settings', v.settings, 'secret_meta', v.secret_meta, 'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

create or replace function public.fn_provider_config_set_scoped(
  p_actor uuid, p_actor_role text, p_code text, p_scope_type text, p_scope_id uuid,
  p_settings jsonb, p_secret_ciphertext text, p_secret_meta jsonb, p_enc_version int)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.payment_provider_config; v_bad text;
begin
  perform public.fn_payment_scope_assert(p_actor, p_actor_role, p_scope_type, p_scope_id);
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  v_bad := public.fn_payment_owner_only_violation(p_actor_role, p_settings);
  if v_bad is not null then raise exception 'OWNER_ONLY_FIELD: %', v_bad; end if;

  select * into v from public.payment_provider_config
   where provider_code = p_code
     and ((p_scope_type = 'platform' and platform_id = p_scope_id) or (p_scope_type = 'site' and site_id = p_scope_id))
   for update;
  if found then
    update public.payment_provider_config
       set settings          = coalesce(p_settings, settings),
           secret_ciphertext = case when p_secret_ciphertext is null then secret_ciphertext
                                    when p_secret_ciphertext = '' then null else p_secret_ciphertext end,
           secret_meta       = case when p_secret_ciphertext is null then secret_meta
                                    when p_secret_ciphertext = '' then '{}'::jsonb else coalesce(p_secret_meta, '{}'::jsonb) end,
           enc_version       = coalesce(p_enc_version, enc_version),
           updated_by        = p_actor,
           updated_at        = now()
     where provider_code = v.provider_code and site_id is not distinct from v.site_id and platform_id is not distinct from v.platform_id
     returning * into v;
  else
    insert into public.payment_provider_config(provider_code, site_id, platform_id, settings, secret_ciphertext, secret_meta, enc_version, updated_by)
    values (p_code,
            case when p_scope_type = 'site' then p_scope_id end,
            case when p_scope_type = 'platform' then p_scope_id end,
            coalesce(p_settings, '{}'::jsonb),
            case when p_secret_ciphertext in ('', null) then null else p_secret_ciphertext end,
            case when p_secret_ciphertext is null or p_secret_ciphertext = '' then '{}'::jsonb else coalesce(p_secret_meta, '{}'::jsonb) end,
            coalesce(p_enc_version, 1), p_actor)
    returning * into v;
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'payment.scope.config', 'payment_provider', p_code,
            jsonb_build_object('scope', p_scope_type || ':' || p_scope_id,
              'settings_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(coalesce(p_settings,'{}'::jsonb)) k),
              'secret_action', case when p_secret_ciphertext is null then 'unchanged' when p_secret_ciphertext = '' then 'cleared' else 'updated' end),
            public.fn_payment_scope_audit_site(p_scope_type, p_scope_id));
  perform pg_notify('payment_providers_changed', p_scope_type || ':' || p_scope_id);

  return jsonb_build_object('provider_code', v.provider_code, 'scope_type', p_scope_type, 'scope_id', p_scope_id,
    'settings', v.settings, 'secret_meta', v.secret_meta, 'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

create or replace function public.fn_provider_config_clear_scoped(
  p_actor uuid, p_actor_role text, p_code text, p_scope_type text, p_scope_id uuid)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  perform public.fn_payment_scope_assert(p_actor, p_actor_role, p_scope_type, p_scope_id);
  delete from public.payment_provider_config
   where provider_code = p_code
     and ((p_scope_type = 'platform' and platform_id = p_scope_id) or (p_scope_type = 'site' and site_id = p_scope_id));
  get diagnostics n = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'payment.scope.config.clear', 'payment_provider', p_code,
            jsonb_build_object('scope', p_scope_type || ':' || p_scope_id, 'removed', n > 0),
            public.fn_payment_scope_audit_site(p_scope_type, p_scope_id));
  perform pg_notify('payment_providers_changed', p_scope_type || ':' || p_scope_id);
  return n > 0;
end;
$fn$;

-- Engine (service role): the EXACT scope's row incl. ciphertext — no fallback to any other scope.
create or replace function public.fn_provider_config_resolve_scoped(p_code text, p_scope_type text, p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.payment_provider_config;
begin
  select * into v from public.payment_provider_config
   where provider_code = p_code
     and ((p_scope_type = 'platform' and platform_id = p_scope_id) or (p_scope_type = 'site' and site_id = p_scope_id));
  if not found then return null; end if;
  return jsonb_build_object('provider_code', v.provider_code, 'scope', p_scope_type || ':' || p_scope_id,
    'settings', v.settings, 'secret_ciphertext', v.secret_ciphertext, 'enc_version', v.enc_version, 'updated_at', v.updated_at);
end;
$fn$;

-- ── 7. go-live switch + owner resolution ─────────────────────────────────────────────────────────
create or replace function public.fn_payment_scope_set_active(
  p_actor uuid, p_actor_role text, p_scope_type text, p_scope_id uuid, p_active boolean, p_payouts_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.payment_scopes;
begin
  perform public.fn_payment_scope_assert(p_actor, p_actor_role, p_scope_type, p_scope_id);
  insert into public.payment_scopes(scope_type, scope_id, active, payouts_enabled, activated_by, activated_at, updated_at)
    values (p_scope_type, p_scope_id, p_active, coalesce(p_payouts_enabled, true),
            case when p_active then p_actor end, case when p_active then now() end, now())
    on conflict (scope_type, scope_id) do update
      set active = excluded.active, payouts_enabled = excluded.payouts_enabled,
          activated_by = case when excluded.active then excluded.activated_by else payment_scopes.activated_by end,
          activated_at = case when excluded.active then excluded.activated_at else payment_scopes.activated_at end,
          updated_at = now()
    returning * into v;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, case when p_active then 'payment.scope.activate' else 'payment.scope.deactivate' end,
            'payment_scope', p_scope_type || ':' || p_scope_id,
            jsonb_build_object('payouts_enabled', v.payouts_enabled),
            public.fn_payment_scope_audit_site(p_scope_type, p_scope_id));
  perform pg_notify('payment_scopes_changed', p_scope_type || ':' || p_scope_id);
  -- docs/43 §3.5: the System owner is told whenever money starts (or stops) flowing through someone
  -- else's accounts. (No self-notification when the owner flips it.)
  insert into public.user_notifications(user_id, level, title, body, category, site_id)
    select pr.id, 'warning',
           left(case when p_active then 'Payments moved to own accounts: ' else 'Payments back on System accounts: ' end
                || coalesce((select name from public.platforms where id = p_scope_id), (select name from public.sites where id = p_scope_id), p_scope_type), 120),
           left(case when p_active
                  then 'Deposits' || case when v.payouts_enabled then ' and withdrawals' else ' (withdrawals DISABLED)' end
                       || ' for this ' || p_scope_type || ' now use its own gateway accounts, not the System''s.'
                  else 'This ' || p_scope_type || ' uses the System''s gateway accounts again.' end, 1000),
           'payments', public.fn_payment_scope_audit_site(p_scope_type, p_scope_id)
      from public.profiles pr
     where pr.role = 'platform_superadmin' and pr.id <> p_actor;
  return jsonb_build_object('scope_type', v.scope_type, 'scope_id', v.scope_id, 'active', v.active,
    'payouts_enabled', v.payouts_enabled, 'activated_at', v.activated_at);
end;
$fn$;

-- The brand's payment owner (docs/43 §2): 'site:<id>' | 'platform:<id>' | 'global' (+ payouts flag).
create or replace function public.fn_payment_owner_scope(p_site uuid)
returns table(scope text, payouts_enabled boolean) language sql stable security definer set search_path = public as $fn$
  select coalesce(
           (select 'site:' || ps.scope_id from public.payment_scopes ps
             where ps.scope_type = 'site' and ps.scope_id = p_site and ps.active),
           (select 'platform:' || ps.scope_id from public.payment_scopes ps join public.sites s on s.platform_id = ps.scope_id
             where ps.scope_type = 'platform' and s.id = p_site and ps.active),
           'global'),
         coalesce(
           (select ps.payouts_enabled from public.payment_scopes ps
             where ps.scope_type = 'site' and ps.scope_id = p_site and ps.active),
           (select ps.payouts_enabled from public.payment_scopes ps join public.sites s on s.platform_id = ps.scope_id
             where ps.scope_type = 'platform' and s.id = p_site and ps.active),
           true);
$fn$;

-- Console listing: the scopes an actor may see (a platform + its brands), with their live state.
create or replace function public.fn_payment_scopes_list(p_actor uuid, p_actor_role text, p_platform uuid)
returns table(scope_type text, scope_id uuid, name text, active boolean, payouts_enabled boolean, activated_at timestamptz)
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform public.fn_payment_scope_assert(p_actor, p_actor_role, 'platform', p_platform);
  return query
    select 'platform'::text, p.id, p.name, coalesce(ps.active, false), coalesce(ps.payouts_enabled, true), ps.activated_at
      from public.platforms p left join public.payment_scopes ps on ps.scope_type = 'platform' and ps.scope_id = p.id
     where p.id = p_platform
    union all
    select 'site'::text, s.id, s.name, coalesce(ps.active, false), coalesce(ps.payouts_enabled, true), ps.activated_at
      from public.sites s left join public.payment_scopes ps on ps.scope_type = 'site' and ps.scope_id = s.id
     where s.platform_id = p_platform
     order by 1, 3;
end;
$fn$;

-- Stamp the scope a provider transaction runs under (engine, service role).
create or replace function public.fn_set_transaction_payment_scope(p_tx uuid, p_scope text)
returns void language sql security definer set search_path = public as $fn$
  update public.transactions set payment_scope = p_scope where id = p_tx;
$fn$;

-- ── 8. per-brand gateway switches: platform admins for their own brands (entitled gateways only) ─
create or replace function public.fn_platform_set_provider_site(
  p_actor uuid, p_actor_role text, p_site uuid, p_code text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  if p_actor_role not in ('platform_superadmin', 'platform_admin') then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site);
  -- a platform admin may only switch ON a gateway the brand is entitled to (add-ons are sold by the owner)
  if p_actor_role = 'platform_admin' and p_enabled and not (p_code = any(public.fn_site_entitled_gateways(p_site))) then
    raise exception 'GATEWAY_NOT_ENTITLED';
  end if;
  insert into public.site_payment_providers(site_id, provider_code, enabled, updated_by, updated_at)
    values (p_site, p_code, p_enabled, p_actor, now())
    on conflict (site_id, provider_code)
      do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.site', 'payment_provider', p_code,
            jsonb_build_object('enabled', p_enabled, 'site_id', p_site), p_site);
  perform pg_notify('payment_providers_changed', p_code);
  return jsonb_build_object('site_id', p_site, 'provider_code', p_code, 'enabled', p_enabled);
end;
$fn$;

create or replace function public.fn_platform_clear_provider_site(
  p_actor uuid, p_actor_role text, p_site uuid, p_code text)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  if p_actor_role not in ('platform_superadmin', 'platform_admin') then raise exception 'NOT_AUTHORIZED'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site);
  delete from public.site_payment_providers where site_id = p_site and provider_code = p_code;
  get diagnostics n = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.site.clear', 'payment_provider', p_code,
            jsonb_build_object('site_id', p_site), p_site);
  perform pg_notify('payment_providers_changed', p_code);
  return n > 0;
end;
$fn$;

-- ── 9. grants: service_role only ─────────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'public.fn_payment_scope_platform(text,uuid)',
    'public.fn_payment_scope_assert(uuid,text,text,uuid)',
    'public.fn_payment_scope_audit_site(text,uuid)',
    'public.fn_payment_owner_only_violation(text,jsonb)',
    'public.fn_provider_config_get_scoped(uuid,text,text,text,uuid)',
    'public.fn_provider_config_set_scoped(uuid,text,text,text,uuid,jsonb,text,jsonb,integer)',
    'public.fn_provider_config_clear_scoped(uuid,text,text,text,uuid)',
    'public.fn_provider_config_resolve_scoped(text,text,uuid)',
    'public.fn_payment_scope_set_active(uuid,text,text,uuid,boolean,boolean)',
    'public.fn_payment_owner_scope(uuid)',
    'public.fn_payment_scopes_list(uuid,text,uuid)',
    'public.fn_set_transaction_payment_scope(uuid,text)',
    'public.fn_admin_get_provider_config(text,text,uuid)',
    'public.fn_platform_set_provider_config(uuid,text,text,uuid,jsonb,text,jsonb,integer)',
    'public.fn_provider_config_resolve(text,uuid)',
    'public.fn_platform_set_provider_site(uuid,text,uuid,text,boolean)',
    'public.fn_platform_clear_provider_site(uuid,text,uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  grant select, insert, update, delete on public.payment_scopes to service_role;
  revoke all on public.payment_scopes from anon, authenticated;
end
$g$;
