-- 0104_default_marketer_guards.sql — active-only default marketer + admin-panel assignment + ban lock.
--
-- Business rules (authoritative, DB-enforced — see docs/09 §3, docs/24 §6.7, BUGLOG #13):
--   1. A brand's DEFAULT marketer (sites.owner_user_id) must be an ACTIVE marketer on that brand.
--      Setting a banned/suspended user as default is rejected (OWNER_NOT_ACTIVE). Applies to BOTH
--      the platform path (fn_platform_set_site_owner) and the new admin path below.
--   2. Brand admins/superadmins can set THEIR OWN brand's default marketer from the Admin panel
--      (fn_admin_set_site_owner) — not just the platform owner. Site is derived from the marketer;
--      site-scoped actors may only act on their own brand (SITE_SCOPE_FORBIDDEN); platform_superadmin
--      is unrestricted.
--   3. The current default marketer CANNOT be banned/suspended while they are a brand's default —
--      the operator must reassign the default first (DEFAULT_MARKETER_LOCKED). This stops a brand
--      from being left earning commission for a disabled account (the exact live bug: a banned
--      marketer remained madolar's default). Reactivating (-> 'active') is always allowed.
--
-- Additive & idempotent (CREATE OR REPLACE); no schema/data changes; money math unchanged (Model B).

-- (1) Platform path: add the ACTIVE-marketer guard (was role+site only).
create or replace function public.fn_platform_set_site_owner(
  p_actor uuid, p_actor_role text, p_site uuid, p_owner uuid
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_role text; v_osite uuid; v_status text;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  if p_owner is not null then
    select role, site_id, status into v_role, v_osite, v_status from public.profiles where id = p_owner;
    if not found then raise exception 'OWNER_NOT_FOUND'; end if;
    if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
    if v_osite <> p_site then raise exception 'OWNER_WRONG_SITE'; end if;
    if v_status <> 'active' then raise exception 'OWNER_NOT_ACTIVE'; end if;
  end if;
  update public.sites set owner_user_id = p_owner, updated_at = now() where id = p_site returning * into v_row;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.set_site_owner', 'site', p_site::text,
            jsonb_build_object('owner_user_id', p_owner), p_site);
  return v_row;
end;
$fn$;

-- (2) Admin path: brand admin/superadmin (or platform_superadmin) sets THEIR brand's default marketer.
--     Site is derived from the marketer. p_make_default=false clears the default IFF this marketer is
--     the current one (idempotent). Validation mirrors the platform path plus site-scope.
create or replace function public.fn_admin_set_site_owner(
  p_actor uuid, p_actor_role text, p_marketer uuid, p_make_default boolean
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_role text; v_status text; v_site uuid; v_actor_site uuid;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select role, status, site_id into v_role, v_status, v_site from public.profiles where id = p_marketer;
  if not found then raise exception 'OWNER_NOT_FOUND'; end if;
  if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
  if not exists (select 1 from public.sites where id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
  -- Site-scoped admins may only act on their own brand; platform_superadmin is unrestricted.
  if p_actor_role in ('admin','superadmin') then
    select site_id into v_actor_site from public.profiles where id = p_actor;
    if v_actor_site is distinct from v_site then raise exception 'SITE_SCOPE_FORBIDDEN'; end if;
  end if;
  if p_make_default then
    if v_status <> 'active' then raise exception 'OWNER_NOT_ACTIVE'; end if;
    update public.sites set owner_user_id = p_marketer, updated_at = now() where id = v_site returning * into v_row;
  else
    update public.sites set owner_user_id = null, updated_at = now()
      where id = v_site and owner_user_id = p_marketer returning * into v_row;
    if v_row.id is null then select * into v_row from public.sites where id = v_site; end if;
  end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'admin.set_site_owner', 'site', v_site::text,
            jsonb_build_object('owner_user_id', case when p_make_default then p_marketer else null end,
                               'marketer', p_marketer, 'make_default', p_make_default), v_site);
  return v_row;
end;
$fn$;

revoke all on function public.fn_admin_set_site_owner(uuid,text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.fn_admin_set_site_owner(uuid,text,uuid,boolean) to service_role;

-- (3) Lock the current default marketer against ban/suspend until reassigned.
create or replace function public.fn_admin_set_user_status(
  p_actor uuid, p_actor_role text, p_target uuid, p_status text, p_reason text
) returns table(user_id uuid, status text)
language plpgsql security definer set search_path = public
as $fn$
declare v_old text; v_target_role text;
begin
  if p_actor_role not in ('admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('active', 'suspended', 'banned') then raise exception 'INVALID_STATUS'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.status, pr.role into v_old, v_target_role from profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if v_target_role in ('admin', 'superadmin', 'platform_superadmin') and p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'INSUFFICIENT_PRIVILEGE'; end if;
  -- A brand's default marketer cannot be disabled while they hold that role — reassign the brand
  -- default first (fn_admin_set_site_owner / platform console). Reactivating is always allowed.
  if p_status <> 'active' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;
  update profiles pr set status = p_status where pr.id = p_target;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.status', 'user', p_target::text, jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  return query select p_target, p_status;
end;
$fn$;
