-- 0052_platform_superadmin.sql — platform-superadmin role + brand onboarding console (docs/22 Task H).
--
-- Introduces the cross-brand operator role and the SECURITY DEFINER RPCs behind the platform
-- console: create a brand, tune its economy, see per-brand KPIs, and override a user — all gated to
-- `platform_superadmin`. A site operator (admin/superadmin scoped to one brand via the JWT `site`
-- claim) never reaches these; only the platform owner does. Every mutation writes an admin_actions
-- audit row. Additive + idempotent.

-- ── 1. Role: platform_superadmin (superset of superadmin; NOT the per-brand superadmin singleton) ──
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('player','marketer','admin','superadmin','platform_superadmin'));

-- ── 2. Brand onboarding: create a site + its default (feasible) economy ───────────────────────────
create or replace function public.fn_platform_create_site(
  p_actor uuid, p_actor_role text, p_slug text, p_name text,
  p_currency text default 'KES', p_primary_domain text default null
) returns uuid
language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(btrim(p_slug),'') = '' or coalesce(btrim(p_name),'') = '' then raise exception 'INVALID_BRAND'; end if;
  insert into public.sites (slug, name, currency, primary_domain, status)
    values (lower(btrim(p_slug)), btrim(p_name), coalesce(nullif(btrim(p_currency),''),'KES'), nullif(btrim(p_primary_domain),''), 'active')
    returning id into v_id;
  -- Seed the brand's economy from column defaults (house_edge 0.75 / win 0.125 → feasible).
  insert into public.site_game_config (site_id, updated_by) values (v_id, p_actor)
    on conflict (site_id) do nothing;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.create', 'site', v_id::text,
            jsonb_build_object('slug', lower(btrim(p_slug)), 'name', btrim(p_name)));
  return v_id;
end;
$fn$;

-- ── 3. Edit a brand's identity/branding ───────────────────────────────────────────────────────────
create or replace function public.fn_platform_update_site(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_before jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(s) into v_before from public.sites s where s.id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;

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
    licence_line   = case when p_patch ? 'licence_line'   then nullif(p_patch->>'licence_line','') else u.licence_line end,
    support_email  = case when p_patch ? 'support_email'  then nullif(p_patch->>'support_email','') else u.support_email end,
    status         = case when p_patch ? 'status'         then p_patch->>'status'               else u.status end,
    updated_at     = now()
  where u.id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.update', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$fn$;

-- ── 4. Tune a brand's economy (site_game_config). Feasibility enforced by the table CHECK; the
--       0046 trigger fires site_game_config_changed so the engine hot-reloads that brand. ─────────
create or replace function public.fn_platform_set_site_config(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb
) returns public.site_game_config
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.site_game_config; v_before jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;

  update public.site_game_config u set
    house_edge         = case when p_patch ? 'house_edge'         then (p_patch->>'house_edge')::numeric        else u.house_edge end,
    max_multiplier     = case when p_patch ? 'max_multiplier'     then (p_patch->>'max_multiplier')::numeric    else u.max_multiplier end,
    min_stake          = case when p_patch ? 'min_stake'          then (p_patch->>'min_stake')::bigint          else u.min_stake end,
    max_stake          = case when p_patch ? 'max_stake'          then (p_patch->>'max_stake')::bigint          else u.max_stake end,
    min_withdrawal     = case when p_patch ? 'min_withdrawal'     then (p_patch->>'min_withdrawal')::bigint     else u.min_withdrawal end,
    default_duration_s = case when p_patch ? 'default_duration_s' then (p_patch->>'default_duration_s')::int    else u.default_duration_s end,
    tick_rate_ms       = case when p_patch ? 'tick_rate_ms'       then (p_patch->>'tick_rate_ms')::int          else u.tick_rate_ms end,
    drift_bias         = case when p_patch ? 'drift_bias'         then (p_patch->>'drift_bias')::numeric        else u.drift_bias end,
    volatility         = case when p_patch ? 'volatility'         then (p_patch->>'volatility')::numeric        else u.volatility end,
    target_win_rate    = case when p_patch ? 'target_win_rate'    then (p_patch->>'target_win_rate')::numeric   else u.target_win_rate end,
    version            = u.version + 1,
    updated_by         = p_actor,
    updated_at         = now()
  where u.site_id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.config', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$fn$;

-- ── 5. All-sites overview: per-brand KPIs (platform_superadmin only) ──────────────────────────────
create or replace function public.fn_platform_overview(p_actor_role text)
returns table(
  site_id uuid, slug text, name text, status text,
  users bigint, deposits_cents bigint, withdrawals_cents bigint,
  ggr_cents bigint, open_positions bigint, bets bigint
)
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select s.id, s.slug, s.name, s.status,
           coalesce(u.n, 0)::bigint,
           coalesce(d.amt, 0)::bigint,
           coalesce(w.amt, 0)::bigint,
           coalesce(p.ggr, 0)::bigint,
           coalesce(p.open_n, 0)::bigint,
           coalesce(p.bet_n, 0)::bigint
      from public.sites s
      left join lateral (select count(*) n from public.profiles pr where pr.site_id = s.id) u on true
      left join lateral (select coalesce(sum(amount),0) amt from public.transactions t where t.site_id = s.id and t.kind='deposit'    and t.status='success') d on true
      left join lateral (select coalesce(sum(amount),0) amt from public.transactions t where t.site_id = s.id and t.kind='withdrawal' and t.status='success') w on true
      left join lateral (select coalesce(sum(stake - payout) filter (where po.status='settled'),0) ggr,
                                count(*) filter (where po.status='open')    open_n,
                                count(*) filter (where po.status='settled') bet_n
                           from public.positions po where po.site_id = s.id) p on true
     order by s.created_at asc;
end;
$fn$;

-- ── 6. Override console: accept platform_superadmin + stamp the target's brand on the override ────
create or replace function public.fn_admin_set_user_overrides(
  p_actor uuid, p_actor_role text, p_target uuid, p_patch jsonb
) returns public.user_overrides
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.user_overrides; v_before jsonb; v_site uuid;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select site_id into v_site from public.profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  select to_jsonb(o) into v_before from public.user_overrides o where o.user_id = p_target;

  insert into public.user_overrides as u (user_id, site_id, win_rate, house_edge, trade_duration_s, max_win_multiplier, min_stake, max_stake, notes, updated_by, updated_at)
  values (
    p_target, v_site,
    case when p_patch ? 'win_rate'           then nullif(p_patch->>'win_rate','')::numeric        else null end,
    case when p_patch ? 'house_edge'         then nullif(p_patch->>'house_edge','')::numeric      else null end,
    case when p_patch ? 'trade_duration_s'   then nullif(p_patch->>'trade_duration_s','')::int    else null end,
    case when p_patch ? 'max_win_multiplier' then nullif(p_patch->>'max_win_multiplier','')::numeric else null end,
    case when p_patch ? 'min_stake'          then nullif(p_patch->>'min_stake','')::bigint        else null end,
    case when p_patch ? 'max_stake'          then nullif(p_patch->>'max_stake','')::bigint        else null end,
    case when p_patch ? 'notes'              then nullif(p_patch->>'notes','')                    else null end,
    p_actor, now()
  )
  on conflict (user_id) do update set
    site_id            = v_site,
    win_rate           = case when p_patch ? 'win_rate'           then nullif(p_patch->>'win_rate','')::numeric        else u.win_rate end,
    house_edge         = case when p_patch ? 'house_edge'         then nullif(p_patch->>'house_edge','')::numeric      else u.house_edge end,
    trade_duration_s   = case when p_patch ? 'trade_duration_s'   then nullif(p_patch->>'trade_duration_s','')::int    else u.trade_duration_s end,
    max_win_multiplier = case when p_patch ? 'max_win_multiplier' then nullif(p_patch->>'max_win_multiplier','')::numeric else u.max_win_multiplier end,
    min_stake          = case when p_patch ? 'min_stake'          then nullif(p_patch->>'min_stake','')::bigint        else u.min_stake end,
    max_stake          = case when p_patch ? 'max_stake'          then nullif(p_patch->>'max_stake','')::bigint        else u.max_stake end,
    notes              = case when p_patch ? 'notes'              then nullif(p_patch->>'notes','')                    else u.notes end,
    updated_by = p_actor, updated_at = now()
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.overrides', 'user', p_target::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$fn$;

-- Grants: platform + override RPCs are service-role only (the engine holds the connection).
do $g$
begin
  revoke all on function public.fn_platform_create_site(uuid,text,text,text,text,text)   from public, anon, authenticated;
  revoke all on function public.fn_platform_update_site(uuid,text,uuid,jsonb)            from public, anon, authenticated;
  revoke all on function public.fn_platform_set_site_config(uuid,text,uuid,jsonb)        from public, anon, authenticated;
  revoke all on function public.fn_platform_overview(text)                               from public, anon, authenticated;
  grant execute on function public.fn_platform_create_site(uuid,text,text,text,text,text) to service_role;
  grant execute on function public.fn_platform_update_site(uuid,text,uuid,jsonb)          to service_role;
  grant execute on function public.fn_platform_set_site_config(uuid,text,uuid,jsonb)      to service_role;
  grant execute on function public.fn_platform_overview(text)                             to service_role;
end
$g$;
