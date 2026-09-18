-- 0133_platform_governance.sql — governance RPCs for the platform tier (Issue 1).
--
-- SECURITY DEFINER RPCs behind the System-Admin + Platform-Admin consoles. Two authorization
-- planes, matching the tier model:
--   • SYSTEM ONLY (platform_superadmin): create/edit platforms, move a site between platforms,
--     appoint/revoke a platform_admin, all-platforms overview.
--   • PLATFORM-SCOPED (platform_admin, within its OWN platform) + SYSTEM: manage the site-level
--     roles/status of users that belong to sites in the platform.
--
-- Isolation is enforced HERE (in the definer) for platform_admin by reading the actor's own
-- platform_id from profiles and refusing any target outside it (PLATFORM_SCOPE_FORBIDDEN) — this
-- is defense-in-depth on top of the API guard, and carries zero regression risk because the
-- platform_admin role did not exist before this migration. Every mutation writes admin_actions.
-- Additive + idempotent (create-or-replace). service_role execute only (the engine holds the conn).

-- ── helper: the platform a user effectively belongs to (their site's platform). ─────────────────
create or replace function public.fn_user_platform(p_user uuid) returns uuid
language sql stable set search_path = public
as $$ select s.platform_id from public.profiles p join public.sites s on s.id = p.site_id where p.id = p_user $$;

-- ══ SYSTEM-ONLY governance ═══════════════════════════════════════════════════════════════════════

-- Create a platform.
create or replace function public.fn_platform_create_platform(
  p_actor uuid, p_actor_role text, p_slug text, p_name text, p_owner uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(btrim(p_slug),'') = '' or coalesce(btrim(p_name),'') = '' then raise exception 'INVALID_PLATFORM'; end if;
  if p_owner is not null and not exists (select 1 from public.profiles where id = p_owner) then
    raise exception 'OWNER_NOT_FOUND';
  end if;
  insert into public.platforms (slug, name, owner_user_id, status)
    values (lower(btrim(p_slug)), btrim(p_name), p_owner, 'active')
    returning id into v_id;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.create', 'platform', v_id::text,
            jsonb_build_object('slug', lower(btrim(p_slug)), 'name', btrim(p_name), 'owner', p_owner));
  return v_id;
end;
$fn$;

-- Edit a platform (name / status / owner / notes).
create or replace function public.fn_platform_update_platform(
  p_actor uuid, p_actor_role text, p_platform_id uuid, p_patch jsonb
) returns public.platforms
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.platforms; v_before jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(x) into v_before from public.platforms x where x.id = p_platform_id;
  if v_before is null then raise exception 'PLATFORM_NOT_FOUND'; end if;
  if p_patch ? 'owner_user_id' and nullif(p_patch->>'owner_user_id','') is not null
     and not exists (select 1 from public.profiles where id = (p_patch->>'owner_user_id')::uuid) then
    raise exception 'OWNER_NOT_FOUND';
  end if;
  update public.platforms u set
    name          = case when p_patch ? 'name'          then btrim(p_patch->>'name')                    else u.name end,
    status        = case when p_patch ? 'status'        then p_patch->>'status'                          else u.status end,
    owner_user_id = case when p_patch ? 'owner_user_id' then nullif(p_patch->>'owner_user_id','')::uuid  else u.owner_user_id end,
    notes         = case when p_patch ? 'notes'         then nullif(p_patch->>'notes','')                else u.notes end,
    updated_at    = now()
  where u.id = p_platform_id
  returning * into v_row;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.update', 'platform', p_platform_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$fn$;

-- Move a site into a platform (system-level: re-parents a brand).
create or replace function public.fn_platform_assign_site(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_platform_id uuid
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_old uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.platforms where id = p_platform_id) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  select platform_id into v_old from public.sites where id = p_site_id;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  update public.sites u set platform_id = p_platform_id, updated_at = now()
    where u.id = p_site_id returning * into v_row;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.assign', 'site', p_site_id::text,
            jsonb_build_object('from_platform', v_old, 'to_platform', p_platform_id));
  return v_row;
end;
$fn$;

-- Appoint a user as platform_admin of a platform (system only). Sets role + platform_id atomically.
create or replace function public.fn_platform_appoint_platform_admin(
  p_actor uuid, p_actor_role text, p_target uuid, p_platform_id uuid
) returns table(user_id uuid, role text, platform_id uuid)
language plpgsql security definer set search_path = public
as $fn$
declare v_old text;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  if not exists (select 1 from public.platforms where id = p_platform_id) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- A brand's default marketer cannot be elevated out of 'marketer' while they still hold the brand.
  if exists (select 1 from public.sites s where s.owner_user_id = p_target) then raise exception 'DEFAULT_MARKETER_LOCKED'; end if;
  update public.profiles pr set role = 'platform_admin', platform_id = p_platform_id where pr.id = p_target;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.admin.appoint', 'user', p_target::text,
            jsonb_build_object('old_role', v_old, 'platform', p_platform_id));
  return query select p_target, 'platform_admin'::text, p_platform_id;
end;
$fn$;

-- Revoke a platform_admin back to a plain site role (system only). Clears platform_id.
create or replace function public.fn_platform_revoke_platform_admin(
  p_actor uuid, p_actor_role text, p_target uuid, p_new_role text default 'admin'
) returns table(user_id uuid, role text)
language plpgsql security definer set search_path = public
as $fn$
declare v_old text;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_new_role not in ('player','marketer','admin') then raise exception 'INVALID_ROLE'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old <> 'platform_admin' then raise exception 'NOT_A_PLATFORM_ADMIN'; end if;
  update public.profiles pr set role = p_new_role, platform_id = null where pr.id = p_target;
  if p_new_role = 'marketer' then perform * from public.fn_affiliate_enroll(p_target); end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.admin.revoke', 'user', p_target::text,
            jsonb_build_object('old_role', v_old, 'new_role', p_new_role));
  return query select p_target, p_new_role;
end;
$fn$;

-- All-platforms overview (system only): one row per platform with headline counts.
create or replace function public.fn_platforms_overview(p_actor_role text)
returns table(platform_id uuid, slug text, name text, status text,
              sites bigint, users bigint, site_admins bigint, platform_admins bigint)
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select pl.id, pl.slug, pl.name, pl.status,
           coalesce(sc.n,0)::bigint,
           coalesce(uc.n,0)::bigint,
           coalesce(ac.n,0)::bigint,
           coalesce(pac.n,0)::bigint
      from public.platforms pl
      left join lateral (select count(*) n from public.sites s where s.platform_id = pl.id) sc on true
      left join lateral (select count(*) n from public.profiles p join public.sites s on s.id=p.site_id where s.platform_id = pl.id) uc on true
      left join lateral (select count(*) n from public.profiles p join public.sites s on s.id=p.site_id where s.platform_id = pl.id and p.role='admin') ac on true
      left join lateral (select count(*) n from public.profiles p where p.role='platform_admin' and p.platform_id = pl.id) pac on true
     order by pl.created_at asc;
end;
$fn$;

-- ══ ROLE / STATUS management — now platform-aware ═════════════════════════════════════════════════
-- Adds platform_admin as a first-class actor and protected target. A platform_admin may manage
-- player/marketer/admin (SITE ADMIN) users, but ONLY within its own platform, and may never touch a
-- platform_admin or higher. platform_admin itself is minted/revoked ONLY via the dedicated RPCs
-- above (never through the generic role setter). Changing a user's role via this RPC clears any
-- stale platform_id (it can only set site-level roles).
create or replace function public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
 returns table(user_id uuid, role text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_old text; v_target_platform uuid; v_actor_platform uuid;
begin
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('player','marketer','admin') then raise exception 'INVALID_ROLE'; end if; -- platform_admin+ via dedicated RPCs
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if v_old = 'platform_admin' then raise exception 'PLATFORM_ADMIN_PROTECTED'; end if; -- use fn_platform_revoke_platform_admin
  -- A plain SITE admin is confined to the player<->marketer transition (cannot mint/lower admins).
  if p_actor_role = 'admin' and (p_role not in ('player','marketer') or v_old not in ('player','marketer')) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  -- A PLATFORM admin may manage player/marketer/admin, but only for users inside ITS OWN platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    v_target_platform := public.fn_user_platform(p_target);
    if v_target_platform is distinct from v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;
  -- Default-marketer lock (unchanged): a brand's default marketer must stay 'marketer'.
  if p_role <> 'marketer' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;

  update public.profiles pr set role = p_role, platform_id = null where pr.id = p_target;
  if p_role = 'marketer' then perform * from public.fn_affiliate_enroll(p_target); end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.set_role', 'user', p_target::text,
            jsonb_build_object('old', v_old, 'new', p_role));
  return query select p_target, p_role;
end;
$function$;

create or replace function public.fn_admin_set_user_status(p_actor uuid, p_actor_role text, p_target uuid, p_status text, p_reason text)
 returns table(user_id uuid, status text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_old text; v_target_role text; v_target_platform uuid; v_actor_platform uuid;
begin
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('active','suspended','banned') then raise exception 'INVALID_STATUS'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.status, pr.role into v_old, v_target_role from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- Only the system owner may act on a platform_admin.
  if v_target_role = 'platform_admin' and p_actor_role <> 'platform_superadmin' then raise exception 'INSUFFICIENT_PRIVILEGE'; end if;
  -- A site/platform admin target may only be actioned by a platform_admin or higher.
  if v_target_role = 'admin' and p_actor_role not in ('platform_admin','superadmin','platform_superadmin') then raise exception 'INSUFFICIENT_PRIVILEGE'; end if;
  -- A PLATFORM admin is confined to users inside ITS OWN platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    v_target_platform := public.fn_user_platform(p_target);
    if v_target_platform is distinct from v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;
  if p_status <> 'active' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;
  update public.profiles pr set status = p_status where pr.id = p_target;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.status', 'user', p_target::text, jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  return query select p_target, p_status;
end;
$function$;

-- ── grants: governance RPCs are service_role only (the engine holds the connection). ────────────
do $g$
begin
  revoke all on function public.fn_platform_create_platform(uuid,text,text,text,uuid)      from public, anon, authenticated;
  revoke all on function public.fn_platform_update_platform(uuid,text,uuid,jsonb)          from public, anon, authenticated;
  revoke all on function public.fn_platform_assign_site(uuid,text,uuid,uuid)               from public, anon, authenticated;
  revoke all on function public.fn_platform_appoint_platform_admin(uuid,text,uuid,uuid)    from public, anon, authenticated;
  revoke all on function public.fn_platform_revoke_platform_admin(uuid,text,uuid,text)     from public, anon, authenticated;
  revoke all on function public.fn_platforms_overview(text)                                from public, anon, authenticated;
  grant execute on function public.fn_platform_create_platform(uuid,text,text,text,uuid)   to service_role;
  grant execute on function public.fn_platform_update_platform(uuid,text,uuid,jsonb)       to service_role;
  grant execute on function public.fn_platform_assign_site(uuid,text,uuid,uuid)            to service_role;
  grant execute on function public.fn_platform_appoint_platform_admin(uuid,text,uuid,uuid) to service_role;
  grant execute on function public.fn_platform_revoke_platform_admin(uuid,text,uuid,text)  to service_role;
  grant execute on function public.fn_platforms_overview(text)                             to service_role;
end
$g$;
