-- 0116_payment_providers_and_megapay.sql — switchable deposit-gateway registry + Mega Pay rail.
--
-- Superadmin gets a registry of deposit providers with a platform-global on/off ("all clients")
-- plus an OPTIONAL per-site override ("force on/off for a specific client"). Multiple providers
-- may be enabled at once; the deposit page renders every provider EFFECTIVE-ENABLED for the
-- player's brand (override wins over global; absent override = inherit global).
--
-- Money-neutral, additive, idempotent, platform_superadmin-gated. It does NOT touch the proven
-- crediting RPC (fn_complete_deposit): a Mega Pay deposit stores its transaction_request_id in
-- transactions.checkout_request_id and settles through the SAME idempotent credit path as Daraja.
-- Seeds 'mpesa' (the existing Daraja rail) ENABLED so behaviour is unchanged until a switch flips.

do $mig$
begin
  -- ── Provider registry (platform-global switch) ──────────────────────────────────────────────
  create table if not exists public.payment_providers (
    code           text primary key,
    display_name   text        not null,
    enabled_global boolean     not null default false,   -- superadmin master switch (all sites)
    sort_order     int         not null default 100,
    updated_by     uuid        references public.profiles(id),
    updated_at     timestamptz not null default now()
  );

  -- ── Per-site override: present row FORCES enabled=true/false for that brand; absent = inherit ──
  create table if not exists public.site_payment_providers (
    site_id       uuid        not null references public.sites(id) on delete cascade,
    provider_code text        not null references public.payment_providers(code) on delete cascade,
    enabled       boolean     not null,
    updated_by    uuid        references public.profiles(id),
    updated_at    timestamptz not null default now(),
    primary key (site_id, provider_code)
  );
  create index if not exists idx_site_payment_providers_site on public.site_payment_providers(site_id);

  -- Seed: mpesa (Daraja) ON so the existing rail is unchanged; megapay OFF until the console flips it.
  insert into public.payment_providers(code, display_name, enabled_global, sort_order) values
    ('mpesa',   'M-Pesa',   true,  10),
    ('megapay', 'Mega Pay', false, 20)
  on conflict (code) do nothing;

  -- Deny-by-default: only the service_role (SECURITY DEFINER RPCs) touches these; no anon/authenticated.
  alter table public.payment_providers      enable row level security;
  alter table public.site_payment_providers enable row level security;
end
$mig$;

-- ── Read: effective providers for a brand (override wins over global) ──────────────────────────
-- Returns EVERY registered provider with its resolved `enabled` for the given site, plus whether an
-- explicit per-site override exists. The player deposit endpoint filters enabled=true; the admin
-- console shows the full matrix.
create or replace function public.fn_list_effective_providers(p_site uuid)
returns table(code text, display_name text, enabled boolean, has_override boolean, sort_order int)
language sql stable security definer set search_path = public as $fn$
  select pp.code, pp.display_name,
         coalesce(o.enabled, pp.enabled_global) as enabled,
         (o.provider_code is not null)          as has_override,
         pp.sort_order
    from public.payment_providers pp
    left join public.site_payment_providers o
      on o.provider_code = pp.code and o.site_id = p_site
   order by pp.sort_order, pp.code;
$fn$;

-- ── Read: full registry + all site overrides for the superadmin console ────────────────────────
create or replace function public.fn_admin_list_providers(p_actor_role text)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  select jsonb_build_object(
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', pp.code, 'display_name', pp.display_name,
        'enabled_global', pp.enabled_global, 'sort_order', pp.sort_order,
        'updated_at', pp.updated_at) order by pp.sort_order, pp.code)
      from public.payment_providers pp), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'site_id', o.site_id, 'provider_code', o.provider_code,
        'enabled', o.enabled, 'updated_at', o.updated_at))
      from public.site_payment_providers o), '[]'::jsonb)
  ) into v;
  return v;
end;
$fn$;

-- ── Write: platform-global toggle (affects all sites without an override) ──────────────────────
create or replace function public.fn_platform_set_provider_global(
  p_actor uuid, p_actor_role text, p_code text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; pp public.payment_providers;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  update public.payment_providers
     set enabled_global = p_enabled, updated_by = p_actor, updated_at = now()
   where code = p_code returning * into pp;
  if not found then raise exception 'PROVIDER_NOT_FOUND'; end if;
  select id into v_site from public.sites order by created_at limit 1;   -- admin_actions.site_id NOT NULL
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.global', 'payment_provider', p_code,
            jsonb_build_object('enabled', p_enabled), v_site);
  perform pg_notify('payment_providers_changed', p_code);
  return to_jsonb(pp);
end;
$fn$;

-- ── Write: per-site override (force on/off for one brand) ──────────────────────────────────────
create or replace function public.fn_platform_set_provider_site(
  p_actor uuid, p_actor_role text, p_site uuid, p_code text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
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

-- ── Write: clear a per-site override (revert that brand to the global default) ──────────────────
create or replace function public.fn_platform_clear_provider_site(
  p_actor uuid, p_actor_role text, p_site uuid, p_code text)
returns boolean language plpgsql security definer set search_path = public as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  delete from public.site_payment_providers where site_id = p_site and provider_code = p_code;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.site.clear', 'payment_provider', p_code,
            jsonb_build_object('site_id', p_site), p_site);
  perform pg_notify('payment_providers_changed', p_code);
  return found;
end;
$fn$;

-- ── Provider-aware deposit create (mirrors fn_create_deposit(site) + a validated provider) ─────
-- Keeps the original fn_create_deposit untouched. Validates the brand's wallet exists and the
-- provider is registered, then inserts a pending deposit stamped with the chosen provider + brand.
create or replace function public.fn_create_deposit_provider(
  p_user uuid, p_amount bigint, p_phone text, p_site_id uuid, p_provider text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid;
begin
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from public.payment_providers where code = p_provider) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  if not exists (select 1 from public.wallets where user_id = p_user and site_id = p_site_id) then raise exception 'WALLET_NOT_FOUND'; end if;
  insert into public.transactions(user_id, site_id, kind, amount, status, provider, phone)
    values (p_user, p_site_id, 'deposit', p_amount, 'pending', p_provider, p_phone)
    returning id into v_id;
  return v_id;
end;
$fn$;

-- ── Grants: service_role only (the API calls these with the service role) ──────────────────────
do $g$
begin
  revoke all on function public.fn_list_effective_providers(uuid)                     from public, anon, authenticated;
  revoke all on function public.fn_admin_list_providers(text)                          from public, anon, authenticated;
  revoke all on function public.fn_platform_set_provider_global(uuid,text,text,boolean) from public, anon, authenticated;
  revoke all on function public.fn_platform_set_provider_site(uuid,text,uuid,text,boolean) from public, anon, authenticated;
  revoke all on function public.fn_platform_clear_provider_site(uuid,text,uuid,text)   from public, anon, authenticated;
  revoke all on function public.fn_create_deposit_provider(uuid,bigint,text,uuid,text) from public, anon, authenticated;

  grant execute on function public.fn_list_effective_providers(uuid)                     to service_role;
  grant execute on function public.fn_admin_list_providers(text)                          to service_role;
  grant execute on function public.fn_platform_set_provider_global(uuid,text,text,boolean) to service_role;
  grant execute on function public.fn_platform_set_provider_site(uuid,text,uuid,text,boolean) to service_role;
  grant execute on function public.fn_platform_clear_provider_site(uuid,text,uuid,text)   to service_role;
  grant execute on function public.fn_create_deposit_provider(uuid,bigint,text,uuid,text) to service_role;

  grant select, insert, update, delete on public.payment_providers      to service_role;
  grant select, insert, update, delete on public.site_payment_providers to service_role;
end
$g$;
