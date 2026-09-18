-- 0130_payment_provider_config.sql — encrypted, UI-editable configuration for deposit gateways.
--
-- WHAT & WHY
-- Migration 0116 gave the superadmin a switch for WHICH gateways players see. This adds the missing
-- half: a place to CONFIGURE each gateway's credentials + settings from the console (MegaPay today;
-- Paystack / Binance Pay / PayHero registered here so they are configurable the moment their keys
-- exist). Today those creds live only in Fly env secrets — invisible and un-editable from the app.
--
-- SECURITY MODEL (defence in depth)
--   * Secret values (api keys, secrets, basic-auth tokens) are encrypted with AES-256-GCM IN THE
--     ENGINE before they ever reach Postgres. The DB stores only ciphertext (`secret_ciphertext`).
--     The AES key lives in a Fly secret (PAYMENTS_CONFIG_ENC_KEY), NEVER in the DB — so a DB dump
--     alone cannot reveal a single credential.
--   * `secret_meta` holds ONLY non-sensitive masked hints (per-field last-4 + presence) for the UI.
--   * Non-secret settings (env, base url, email, channel id, callback url) live in plaintext `settings`.
--   * Reads for the console (`fn_admin_get_provider_config`) return settings + masked meta, NEVER the
--     ciphertext or plaintext. Only the service-role engine path (`fn_provider_config_resolve`) sees
--     ciphertext, and it still needs the env key to decrypt.
--   * All writes are platform_superadmin-gated, audited in admin_actions (no secret in the audit
--     detail), and emit pg_notify('payment_providers_changed') so live engines refresh.
--
-- Money-neutral, additive, idempotent. Touches no crediting RPC. Registering paystack/binance/payhero
-- leaves them enabled_global=false (hidden) exactly like megapay was in 0116.

do $mig$
begin
  -- ── Config store: one GLOBAL row per provider (site_id null) + optional per-brand override rows ──
  create table if not exists public.payment_provider_config (
    provider_code     text        not null references public.payment_providers(code) on delete cascade,
    site_id           uuid        null     references public.sites(id) on delete cascade, -- null = global default
    settings          jsonb       not null default '{}'::jsonb,   -- NON-secret settings only
    secret_ciphertext text        null,                           -- AES-256-GCM (base64) of the secret-field JSON
    secret_meta       jsonb       not null default '{}'::jsonb,   -- masked hints only: {field:{last4,set}}
    enc_version       int         not null default 1,             -- crypto scheme version (rotation-ready)
    updated_by        uuid        references public.profiles(id),
    updated_at        timestamptz not null default now(),
    created_at        timestamptz not null default now()
  );

  -- Exactly one global row per provider, and at most one row per (provider, brand).
  create unique index if not exists uq_provider_config_global
    on public.payment_provider_config(provider_code) where site_id is null;
  create unique index if not exists uq_provider_config_site
    on public.payment_provider_config(provider_code, site_id) where site_id is not null;
  create index if not exists idx_provider_config_site on public.payment_provider_config(site_id);

  -- Register the three new gateways alongside the existing rails (hidden until switched on, like 0116).
  insert into public.payment_providers(code, display_name, enabled_global, sort_order) values
    ('paystack', 'Paystack',    false, 30),
    ('binance',  'Binance Pay', false, 40),
    ('payhero',  'PayHero',     false, 50)
  on conflict (code) do nothing;

  -- Deny-by-default: only the service_role (SECURITY DEFINER RPCs) touches this; no anon/authenticated.
  alter table public.payment_provider_config enable row level security;
end
$mig$;

-- ── Read (console): settings + MASKED secret hints for one provider/scope. NEVER ciphertext. ──────
create or replace function public.fn_admin_get_provider_config(
  p_actor_role text, p_code text, p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.payment_provider_config;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.payment_providers where code = p_code) then raise exception 'PROVIDER_NOT_FOUND'; end if;
  select * into v from public.payment_provider_config
   where provider_code = p_code and site_id is not distinct from p_site;
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

-- ── Write (console): upsert config. The ENGINE supplies pre-encrypted ciphertext + masked meta. ───
-- p_secret_ciphertext NULL  => leave the stored secret UNTOUCHED (settings-only edit).
-- p_secret_ciphertext ''    => CLEAR the stored secret (explicit removal).
-- p_secret_ciphertext '...' => replace the stored secret.
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
   where provider_code = p_code and site_id is not distinct from p_site;

  if found then
    update public.payment_provider_config
       set settings          = coalesce(p_settings, settings),
           secret_ciphertext = case
                                  when p_secret_ciphertext is null then secret_ciphertext        -- keep
                                  when p_secret_ciphertext = ''    then null                      -- clear
                                  else p_secret_ciphertext end,                                   -- replace
           secret_meta       = case
                                  when p_secret_ciphertext is null then secret_meta
                                  when p_secret_ciphertext = ''    then '{}'::jsonb
                                  else coalesce(p_secret_meta, '{}'::jsonb) end,
           enc_version       = coalesce(p_enc_version, enc_version),
           updated_by        = p_actor,
           updated_at        = now()
     where provider_code = p_code and site_id is not distinct from p_site
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

  select id into v_audit_site from public.sites order by created_at limit 1; -- admin_actions.site_id NOT NULL
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.provider.config', 'payment_provider', p_code,
            jsonb_build_object(
              'site_id', p_site,
              'settings_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(coalesce(p_settings,'{}'::jsonb)) k),
              'secret_action', case when p_secret_ciphertext is null then 'unchanged'
                                    when p_secret_ciphertext = '' then 'cleared' else 'updated' end),
            coalesce(v_audit_site, '00000000-0000-0000-0000-000000000001'::uuid));
  perform pg_notify('payment_providers_changed', p_code);

  return jsonb_build_object(
    'provider_code', v.provider_code, 'site_id', v.site_id,
    'settings', v.settings, 'secret_meta', v.secret_meta,
    'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

-- ── Resolve (engine, service-role only): settings + CIPHERTEXT for decryption at use-time. ────────
-- Prefers the per-brand row, falls back to the global row. Ciphertext is inert without the env key.
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
  select * into v from public.payment_provider_config where provider_code = p_code and site_id is null;
  if not found then return null; end if;
  return jsonb_build_object('provider_code', v.provider_code, 'site_id', null,
    'settings', v.settings, 'secret_ciphertext', v.secret_ciphertext, 'enc_version', v.enc_version, 'scope', 'global');
end;
$fn$;

-- ── Grants: service_role only (the API/engine call these with the service role). ──────────────────
do $g$
begin
  revoke all on function public.fn_admin_get_provider_config(text,text,uuid)                                    from public, anon, authenticated;
  revoke all on function public.fn_platform_set_provider_config(uuid,text,text,uuid,jsonb,text,jsonb,int)        from public, anon, authenticated;
  revoke all on function public.fn_provider_config_resolve(text,uuid)                                            from public, anon, authenticated;

  grant execute on function public.fn_admin_get_provider_config(text,text,uuid)                                  to service_role;
  grant execute on function public.fn_platform_set_provider_config(uuid,text,text,uuid,jsonb,text,jsonb,int)      to service_role;
  grant execute on function public.fn_provider_config_resolve(text,uuid)                                          to service_role;

  grant select, insert, update, delete on public.payment_provider_config to service_role;
end
$g$;
