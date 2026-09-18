-- 0134_platform_scoped_site_rpcs.sql — let a platform_admin manage the SITES in its own platform.
--
-- 0052/0060/0120 gave the SYSTEM owner (platform_superadmin) the site create/edit/config/overview
-- RPCs. Issue 1 grants the same powers to a PLATFORM admin, but bounded to sites in ITS platform.
-- These are exact copies of the current bodies (preserving every later column: chart_style,
-- trade_ui, mpesa_*, legal_copy, min_withdrawal_native, the v_real_* overview) with ONLY the
-- authorization guard widened + a platform-scope check added. Isolation is enforced in-definer by
-- reading the actor's own platform_id, so a platform_admin can never reach another platform's site
-- (PLATFORM_SCOPE_FORBIDDEN). Additive + idempotent. Zero regression: platform_admin is new, and
-- the platform_superadmin path is byte-for-byte unchanged in behaviour.

-- ── helper: assert the actor may act on p_site (raises on violation), else return silently. ──────
create or replace function public.fn_platform_site_in_scope(p_actor uuid, p_actor_role text, p_site uuid)
returns void language plpgsql stable security definer set search_path = public
as $fn$
declare v_actor_platform uuid; v_site_platform uuid;
begin
  if p_actor_role = 'platform_superadmin' then return; end if;          -- system: unrestricted
  if p_actor_role <> 'platform_admin' then raise exception 'NOT_AUTHORIZED'; end if;
  select platform_id into v_actor_platform from public.profiles where id = p_actor;
  if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
  select platform_id into v_site_platform from public.sites where id = p_site;
  if v_site_platform is null then raise exception 'SITE_NOT_FOUND'; end if;
  if v_site_platform <> v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
end;
$fn$;

-- ── create a site — stamped into the actor's platform (system -> default platform). ─────────────
create or replace function public.fn_platform_create_site(p_actor uuid, p_actor_role text, p_slug text, p_name text, p_currency text DEFAULT 'KES'::text, p_primary_domain text DEFAULT NULL::text)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid; v_platform uuid;
begin
  if p_actor_role = 'platform_superadmin' then
    v_platform := '10000000-0000-0000-0000-000000000001';
  elsif p_actor_role = 'platform_admin' then
    select platform_id into v_platform from public.profiles where id = p_actor;
    if v_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
  else
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(btrim(p_slug),'') = '' or coalesce(btrim(p_name),'') = '' then raise exception 'INVALID_BRAND'; end if;
  insert into public.sites (slug, name, currency, primary_domain, status, platform_id)
    values (lower(btrim(p_slug)), btrim(p_name), coalesce(nullif(btrim(p_currency),''),'KES'), nullif(btrim(p_primary_domain),''), 'active', v_platform)
    returning id into v_id;
  insert into public.site_game_config (site_id, updated_by) values (v_id, p_actor)
    on conflict (site_id) do nothing;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.create', 'site', v_id::text,
            jsonb_build_object('slug', lower(btrim(p_slug)), 'name', btrim(p_name), 'platform', v_platform));
  return v_id;
end;
$function$;

-- ── edit a site — bounded to the actor's platform. ──────────────────────────────────────────────
create or replace function public.fn_platform_update_site(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 returns sites language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.sites; v_before jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(s) into v_before from public.sites s where s.id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site_id);

  update public.sites u set
    name           = case when p_patch ? 'name'           then btrim(p_patch->>'name')          else u.name end,
    primary_domain = case when p_patch ? 'primary_domain' then nullif(btrim(p_patch->>'primary_domain'),'') else u.primary_domain end,
    logo_url       = case when p_patch ? 'logo_url'       then nullif(p_patch->>'logo_url','')  else u.logo_url end,
    favicon_url    = case when p_patch ? 'favicon_url'    then nullif(p_patch->>'favicon_url','') else u.favicon_url end,
    wordmark_text  = case when p_patch ? 'wordmark_text'  then nullif(p_patch->>'wordmark_text','') else u.wordmark_text end,
    color_primary  = case when p_patch ? 'color_primary'  then p_patch->>'color_primary'        else u.color_primary end,
    color_bg       = case when p_patch ? 'color_bg'       then p_patch->>'color_bg'             else u.color_bg end,
    color_accent   = case when p_patch ? 'color_accent'   then p_patch->>'color_accent'         else u.color_accent end,
    theme          = case when p_patch ? 'theme'          then p_patch->>'theme'                else u.theme end,
    currency       = case when p_patch ? 'currency'       then p_patch->>'currency'             else u.currency end,
    locale         = case when p_patch ? 'locale'         then p_patch->>'locale'               else u.locale end,
    chart_style    = case when p_patch ? 'chart_style'    then p_patch->>'chart_style'          else u.chart_style end,
    trade_ui       = case when p_patch ? 'trade_ui'       then p_patch->>'trade_ui'             else u.trade_ui end,
    licence_line   = case when p_patch ? 'licence_line'   then nullif(p_patch->>'licence_line','') else u.licence_line end,
    support_email  = case when p_patch ? 'support_email'  then nullif(p_patch->>'support_email','') else u.support_email end,
    status         = case when p_patch ? 'status'         then p_patch->>'status'               else u.status end,
    mpesa_env           = case when p_patch ? 'mpesa_env'            then nullif(p_patch->>'mpesa_env','')            else u.mpesa_env end,
    mpesa_shortcode     = case when p_patch ? 'mpesa_shortcode'      then nullif(p_patch->>'mpesa_shortcode','')      else u.mpesa_shortcode end,
    mpesa_callback_base = case when p_patch ? 'mpesa_callback_base'  then nullif(p_patch->>'mpesa_callback_base','')  else u.mpesa_callback_base end,
    mpesa_b2c_initiator = case when p_patch ? 'mpesa_b2c_initiator'  then nullif(p_patch->>'mpesa_b2c_initiator','')  else u.mpesa_b2c_initiator end,
    legal_copy          = case when p_patch ? 'legal_copy'           then p_patch->'legal_copy'                       else u.legal_copy end,
    updated_at     = now()
  where u.id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.update', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$;

-- ── tune a site's economy — bounded to the actor's platform. ────────────────────────────────────
create or replace function public.fn_platform_set_site_config(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 returns site_game_config language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.site_game_config; v_before jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site_id);
  if p_patch ? 'min_withdrawal_native'
     and (p_patch->>'min_withdrawal_native') is not null
     and (p_patch->>'min_withdrawal_native')::numeric <= 0 then
    raise exception 'INVALID_MIN_WITHDRAWAL_NATIVE';
  end if;

  update public.site_game_config u set
    house_edge            = case when p_patch ? 'house_edge'            then (p_patch->>'house_edge')::numeric            else u.house_edge end,
    max_multiplier        = case when p_patch ? 'max_multiplier'        then (p_patch->>'max_multiplier')::numeric        else u.max_multiplier end,
    min_stake             = case when p_patch ? 'min_stake'             then (p_patch->>'min_stake')::bigint             else u.min_stake end,
    max_stake             = case when p_patch ? 'max_stake'             then (p_patch->>'max_stake')::bigint             else u.max_stake end,
    min_withdrawal        = case when p_patch ? 'min_withdrawal'        then (p_patch->>'min_withdrawal')::bigint        else u.min_withdrawal end,
    min_withdrawal_native = case when p_patch ? 'min_withdrawal_native' then (p_patch->>'min_withdrawal_native')::numeric else u.min_withdrawal_native end,
    default_duration_s    = case when p_patch ? 'default_duration_s'    then (p_patch->>'default_duration_s')::int       else u.default_duration_s end,
    tick_rate_ms          = case when p_patch ? 'tick_rate_ms'          then (p_patch->>'tick_rate_ms')::int             else u.tick_rate_ms end,
    drift_bias            = case when p_patch ? 'drift_bias'            then (p_patch->>'drift_bias')::numeric           else u.drift_bias end,
    volatility            = case when p_patch ? 'volatility'            then (p_patch->>'volatility')::numeric           else u.volatility end,
    target_win_rate       = case when p_patch ? 'target_win_rate'       then (p_patch->>'target_win_rate')::numeric      else u.target_win_rate end,
    version               = u.version + 1,
    updated_by            = p_actor,
    updated_at            = now()
  where u.site_id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.config', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$;

-- ── platform-scoped overview (NEW 2-arg overload). The existing 1-arg fn_platform_overview(text)
--    is left intact so a not-yet-redeployed API keeps working (no SQL/code ordering hazard). This
--    overload returns only the caller's platform sites for a platform_admin, all sites for system.
create or replace function public.fn_platform_overview(p_actor uuid, p_actor_role text)
returns TABLE(site_id uuid, slug text, name text, status text, users bigint, deposits_cents bigint, withdrawals_cents bigint, ggr_cents bigint, open_positions bigint, bets bigint)
language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor_platform uuid;
begin
  if p_actor_role = 'platform_superadmin' then
    v_actor_platform := null;                                    -- all platforms
  elsif p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
  else
    raise exception 'NOT_AUTHORIZED';
  end if;
  return query
    select s.id, s.slug, s.name, s.status,
           coalesce(u.n, 0)::bigint, coalesce(d.amt, 0)::bigint, coalesce(w.amt, 0)::bigint,
           coalesce(p.ggr, 0)::bigint, coalesce(p.open_n, 0)::bigint, coalesce(p.bet_n, 0)::bigint
      from public.sites s
      left join lateral (select count(*) n from public.v_real_profiles pr where pr.site_id = s.id) u on true
      left join lateral (select coalesce(sum(amount),0) amt from public.v_real_transactions t
                          where t.site_id = s.id and t.kind='deposit' and t.status='success') d on true
      left join lateral (select coalesce(sum(amount),0) amt from public.v_real_transactions t
                          where t.site_id = s.id and t.kind='withdrawal' and t.status='success'
                            and t.provider is distinct from 'internal') w on true
      left join lateral (select coalesce(sum(stake - payout) filter (where po.status='settled'),0) ggr,
                                count(*) filter (where po.status='open')    open_n,
                                count(*) filter (where po.status='settled') bet_n
                           from public.v_real_positions po where po.site_id = s.id) p on true
     where v_actor_platform is null or s.platform_id = v_actor_platform
     order by s.created_at asc;
end;
$function$;

-- ── grants ──────────────────────────────────────────────────────────────────────────────────────
do $g$
begin
  revoke all on function public.fn_platform_site_in_scope(uuid,text,uuid)     from public, anon, authenticated;
  revoke all on function public.fn_platform_overview(uuid,text)               from public, anon, authenticated;
  grant execute on function public.fn_platform_site_in_scope(uuid,text,uuid)  to service_role;
  grant execute on function public.fn_platform_overview(uuid,text)            to service_role;
  -- create/update/config keep their existing service_role grants (create-or-replace preserves them).
end
$g$;
