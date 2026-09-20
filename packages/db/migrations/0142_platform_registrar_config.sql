-- 0142_platform_registrar_config.sql — per-PLATFORM, encrypted, UI-editable domain-registrar config.
--
-- WHY (Issue 1 #3): domain provisioning during client onboarding uses a domain registrar (Namecheap)
-- whose credentials today live ONLY in global Fly env (NAMECHEAP_API_USER/USERNAME/API_KEY/CLIENT_IP)
-- — invisible and un-editable from the app, and shared across every platform. Platform admins must be
-- able to configure THEIR OWN registrar so they can onboard their own clients' domains. This adds a
-- per-platform config store, mirroring the proven payment_provider_config pattern (migration 0130):
--   * The API KEY is encrypted with AES-256-GCM IN THE ENGINE before it reaches Postgres; the DB only
--     ever stores ciphertext (`secret_ciphertext`). The key lives in an env secret
--     (REGISTRAR_CONFIG_ENC_KEY, falling back to PAYMENTS_CONFIG_ENC_KEY), NEVER in the DB.
--   * `secret_meta` holds ONLY masked hints (last-4 + presence) for the console.
--   * Non-secret settings (api_user, username, client_ip) live in plaintext `settings`.
--   * Reads for the console (fn_platform_get_registrar_config) return settings + masked meta, NEVER
--     the ciphertext. Only the service-role resolve path (fn_registrar_config_resolve) returns
--     ciphertext, and it is inert without the env key.
--   * A PLATFORM ADMIN may read/write ONLY its own platform's row; the system owner may act on any.
--     Writes are audited (no secret in the audit) and emit pg_notify('registrar_config_changed').
-- Additive + idempotent. No global env behaviour changes (the engine falls back to env for the
-- default platform when no row exists — see registrarconfig.ts).

do $mig$
begin
  create table if not exists public.platform_registrar_config (
    platform_id       uuid        not null references public.platforms(id) on delete cascade,
    provider_code     text        not null default 'namecheap',
    settings          jsonb       not null default '{}'::jsonb,   -- NON-secret: api_user, username, client_ip
    secret_ciphertext text        null,                           -- AES-256-GCM (base64) of {"api_key": "..."}
    secret_meta       jsonb       not null default '{}'::jsonb,   -- masked hints only: {api_key:{last4,set}}
    enc_version       int         not null default 1,             -- crypto scheme version (rotation-ready)
    updated_by        uuid        references public.profiles(id),
    updated_at        timestamptz not null default now(),
    created_at        timestamptz not null default now(),
    primary key (platform_id, provider_code)
  );

  -- Deny-by-default: only the service_role (SECURITY DEFINER RPCs) touches this; no anon/authenticated.
  alter table public.platform_registrar_config enable row level security;
end
$mig$;

-- ── scope helper: which platform (if any) the actor may act on for registrar config ──────────────
-- Returns TRUE when the actor may read/write the given platform's registrar config.
create or replace function public.fn_registrar_actor_may(p_actor uuid, p_actor_role text, p_platform uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select case
    when p_actor_role = 'platform_superadmin' then true
    when p_actor_role = 'platform_admin'
      then p_platform is not null
       and p_platform = (select pr.platform_id from public.profiles pr where pr.id = p_actor)
    else false
  end;
$fn$;

-- ── Read (console): settings + MASKED secret hints for a platform. NEVER ciphertext. ─────────────
create or replace function public.fn_platform_get_registrar_config(
  p_actor uuid, p_actor_role text, p_platform uuid, p_code text default 'namecheap')
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.platform_registrar_config;
begin
  if p_actor_role = 'platform_admin' and p_platform is distinct from (select pr.platform_id from public.profiles pr where pr.id = p_actor) then
    raise exception 'PLATFORM_SCOPE_FORBIDDEN';
  end if;
  if not public.fn_registrar_actor_may(p_actor, p_actor_role, p_platform) then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;

  select * into v from public.platform_registrar_config where platform_id = p_platform and provider_code = p_code;
  if not found then
    return jsonb_build_object(
      'platform_id', p_platform, 'provider_code', p_code,
      'settings', '{}'::jsonb, 'secret_meta', '{}'::jsonb,
      'has_secret', false, 'enc_version', 1, 'updated_at', null, 'exists', false);
  end if;
  return jsonb_build_object(
    'platform_id', v.platform_id, 'provider_code', v.provider_code,
    'settings', v.settings, 'secret_meta', v.secret_meta,
    'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

-- ── Write (console): upsert config. The ENGINE supplies pre-encrypted ciphertext + masked meta. ──
-- p_secret_ciphertext NULL => leave the stored secret UNTOUCHED (settings-only edit).
-- p_secret_ciphertext ''   => CLEAR the stored secret.  '...' => replace it.
create or replace function public.fn_platform_set_registrar_config(
  p_actor uuid, p_actor_role text, p_platform uuid, p_code text,
  p_settings jsonb, p_secret_ciphertext text, p_secret_meta jsonb, p_enc_version int)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.platform_registrar_config; v_audit_site uuid;
begin
  if p_actor_role = 'platform_admin' and p_platform is distinct from (select pr.platform_id from public.profiles pr where pr.id = p_actor) then
    raise exception 'PLATFORM_SCOPE_FORBIDDEN';
  end if;
  if not public.fn_registrar_actor_may(p_actor, p_actor_role, p_platform) then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;

  select * into v from public.platform_registrar_config where platform_id = p_platform and provider_code = p_code;
  if found then
    update public.platform_registrar_config
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
     where platform_id = p_platform and provider_code = p_code
     returning * into v;
  else
    insert into public.platform_registrar_config(
      platform_id, provider_code, settings, secret_ciphertext, secret_meta, enc_version, updated_by)
    values (
      p_platform, p_code, coalesce(p_settings, '{}'::jsonb),
      case when p_secret_ciphertext is null or p_secret_ciphertext = '' then null else p_secret_ciphertext end,
      case when p_secret_ciphertext is null or p_secret_ciphertext = '' then '{}'::jsonb else coalesce(p_secret_meta,'{}'::jsonb) end,
      coalesce(p_enc_version, 1), p_actor)
    returning * into v;
  end if;

  -- admin_actions.site_id is NOT NULL; prefer a site in this platform, else the oldest site.
  select id into v_audit_site from public.sites where platform_id = p_platform order by created_at limit 1;
  if v_audit_site is null then select id into v_audit_site from public.sites order by created_at limit 1; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.registrar.config', 'platform', p_platform::text,
            jsonb_build_object(
              'provider_code', p_code,
              'settings_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(coalesce(p_settings,'{}'::jsonb)) k),
              'secret_action', case when p_secret_ciphertext is null then 'unchanged'
                                    when p_secret_ciphertext = '' then 'cleared' else 'updated' end),
            coalesce(v_audit_site, '00000000-0000-0000-0000-000000000001'::uuid));
  perform pg_notify('registrar_config_changed', p_platform::text);

  return jsonb_build_object(
    'platform_id', v.platform_id, 'provider_code', v.provider_code,
    'settings', v.settings, 'secret_meta', v.secret_meta,
    'has_secret', (v.secret_ciphertext is not null),
    'enc_version', v.enc_version, 'updated_at', v.updated_at, 'exists', true);
end;
$fn$;

-- ── Resolve (engine, service-role only): settings + CIPHERTEXT for decryption at provision-time. ──
create or replace function public.fn_registrar_config_resolve(p_platform uuid, p_code text default 'namecheap')
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v public.platform_registrar_config;
begin
  select * into v from public.platform_registrar_config where platform_id = p_platform and provider_code = p_code;
  if not found then return null; end if;
  return jsonb_build_object('platform_id', v.platform_id, 'provider_code', v.provider_code,
    'settings', v.settings, 'secret_ciphertext', v.secret_ciphertext, 'enc_version', v.enc_version);
end;
$fn$;

-- ── Grants: service_role only (the API/engine call these with the service role). ─────────────────
do $g$
begin
  revoke all on function public.fn_registrar_actor_may(uuid,text,uuid)                                             from public, anon, authenticated;
  revoke all on function public.fn_platform_get_registrar_config(uuid,text,uuid,text)                              from public, anon, authenticated;
  revoke all on function public.fn_platform_set_registrar_config(uuid,text,uuid,text,jsonb,text,jsonb,int)         from public, anon, authenticated;
  revoke all on function public.fn_registrar_config_resolve(uuid,text)                                             from public, anon, authenticated;

  grant execute on function public.fn_registrar_actor_may(uuid,text,uuid)                                          to service_role;
  grant execute on function public.fn_platform_get_registrar_config(uuid,text,uuid,text)                          to service_role;
  grant execute on function public.fn_platform_set_registrar_config(uuid,text,uuid,text,jsonb,text,jsonb,int)      to service_role;
  grant execute on function public.fn_registrar_config_resolve(uuid,text)                                          to service_role;

  grant select, insert, update, delete on public.platform_registrar_config to service_role;
end
$g$;
