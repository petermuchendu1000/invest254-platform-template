-- 0141_notification_audience_scope.sql — SCOPE broadcast audience + category-clear to the actor's tenant.
--
-- FIX (Issue 1 — cross-tenant data leak). Migration 0106 resolved the broadcast audience with
-- fn_notification_audience(jsonb), which selects from public.profiles across the ENTIRE system and
-- takes NO actor argument. Consequences on the multi-tenant deployment:
--   * fn_notification_audience_count(jsonb) counted every user in every brand/platform for any admin;
--   * fn_broadcast_notification(...) let a SITE admin message (and, via resolves_category, clear
--     banners for) users of OTHER brands — a cross-tenant read AND write leak;
--   * the role gate excluded 'platform_admin', so a platform admin could not broadcast at all.
--
-- This migration makes audience resolution + category-clear ACTOR-SCOPED, exactly matching the tier
-- model (docs/38):
--   * site admin ('admin'/'superadmin')     -> ONLY its own site's users;
--   * platform admin ('platform_admin')     -> ALL users across the sites in ITS platform;
--   * system owner ('platform_superadmin')  -> everyone.
-- An explicit { "sites":[...] } audience filter can only NARROW within the caller's allowed sites
-- (it can never broaden reach). Additive + idempotent (create or replace only; no data change). The
-- legacy 1-arg fn_notification_audience / fn_notification_audience_count are left intact so nothing
-- that might still reference them breaks (no code does).

-- ── (0) The set of site_ids an actor may target ────────────────────────────────────────────────
create or replace function public.fn_actor_target_sites(p_actor uuid, p_actor_role text)
returns table(site_id uuid)
language sql stable security definer set search_path = public as $fn$
  select s.id
  from public.sites s
  where
    p_actor_role = 'platform_superadmin'
    or ( p_actor_role = 'platform_admin'
         and s.platform_id = (select p.platform_id from public.profiles p where p.id = p_actor) )
    or ( p_actor_role in ('admin','superadmin')
         and s.id = (select p.site_id from public.profiles p where p.id = p_actor) );
$fn$;

-- ── (1) Actor-scoped audience resolver ─────────────────────────────────────────────────────────
create or replace function public.fn_notification_audience_scoped(
  p_actor uuid, p_actor_role text, p_audience jsonb
) returns table(user_id uuid, site_id uuid)
language sql stable security definer set search_path = public as $fn$
  select p.id, p.site_id
  from public.profiles p
  where p.status = coalesce(nullif(p_audience->>'status',''), 'active')
    and p.role in ('player','marketer','admin','superadmin','super_admin','platform_superadmin')
    -- HARD tenant bound: the caller can never exceed its own sites.
    and p.site_id in (select fas.site_id from public.fn_actor_target_sites(p_actor, p_actor_role) fas)
    -- optional explicit role filter
    and ( not (p_audience ? 'roles')
          or p.role in (select jsonb_array_elements_text(p_audience->'roles')) )
    -- optional brand/site filter (can only NARROW within the allowed sites above)
    and ( not (p_audience ? 'sites')
          or p.site_id in (select (jsonb_array_elements_text(p_audience->'sites'))::uuid) )
    -- optional "affected only": users with a FAILED payment of the given kind within the window
    and ( not (p_audience ? 'affected_within_hours')
          or p.id in (
            select t.user_id from public.transactions t
            where t.kind = coalesce(nullif(p_audience->>'affected_kind',''), 'deposit')
              and t.status = 'failed'
              and t.created_at > now() - (greatest((p_audience->>'affected_within_hours')::int, 0) * interval '1 hour')
          ) );
$fn$;

create or replace function public.fn_notification_audience_count_scoped(
  p_actor uuid, p_actor_role text, p_audience jsonb
) returns integer language sql stable security definer set search_path = public as $fn$
  select count(*)::int
  from public.fn_notification_audience_scoped(p_actor, p_actor_role, coalesce(p_audience, '{}'::jsonb));
$fn$;

-- ── (2) Broadcast — now actor-scoped, and platform_admin may broadcast ──────────────────────────
create or replace function public.fn_broadcast_notification(
  p_actor uuid, p_actor_role text, p_template_key text, p_audience jsonb default null
) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_tmpl public.notification_templates; v_aud jsonb; v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  select * into v_tmpl from public.notification_templates where key = p_template_key and active;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;

  v_aud := coalesce(p_audience, v_tmpl.default_audience, '{}'::jsonb);

  -- A "restored/complete" template clears the incident banners it supersedes first — but ONLY within
  -- the caller's own sites (a site admin must not clear another brand's banners).
  if v_tmpl.resolves_category is not null then
    update public.user_notifications set resolved_at = now()
      where category = v_tmpl.resolves_category
        and dismissed_at is null and resolved_at is null
        and site_id in (select fas.site_id from public.fn_actor_target_sites(p_actor, p_actor_role) fas);
  end if;

  with ins as (
    insert into public.user_notifications
      (user_id, level, title, body, dismissible, category, created_by, site_id)
    select a.user_id, v_tmpl.level, v_tmpl.title, v_tmpl.body, v_tmpl.dismissible, v_tmpl.category, p_actor, a.site_id
    from public.fn_notification_audience_scoped(p_actor, p_actor_role, v_aud) a
    where not exists (
      select 1 from public.user_notifications n
      where n.user_id = a.user_id and n.category = v_tmpl.category
        and n.dismissed_at is null and n.resolved_at is null
    )
    returning 1
  )
  select count(*)::int into v_count from ins;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.broadcast', 'template', p_template_key,
            jsonb_build_object('recipients', v_count, 'category', v_tmpl.category,
                               'level', v_tmpl.level, 'audience', v_aud));
  return v_count;
end;
$fn$;

-- ── (3) Resolve a category — now actor-scoped (site admin clears ONLY its brand) ────────────────
create or replace function public.fn_resolve_notifications_by_category(
  p_actor uuid, p_actor_role text, p_category text
) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.user_notifications set resolved_at = now()
    where category = p_category and dismissed_at is null and resolved_at is null
      and site_id in (select fas.site_id from public.fn_actor_target_sites(p_actor, p_actor_role) fas);
  get diagnostics v_count = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.resolve_category', 'category', p_category,
            jsonb_build_object('cleared', v_count));
  return v_count;
end;
$fn$;
