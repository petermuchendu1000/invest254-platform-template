-- 0080_admin_user_management.sql — expand brand-admin user management (item 6).
--
--  (1) fn_admin_update_user: edit a user's phone / username (the "edit user details" gap). Admin+.
--      Per-brand uniqueness (uq_profiles_site_phone / uq_profiles_site_username) is pre-checked so the
--      caller gets a clean PHONE_TAKEN / USERNAME_TAKEN instead of a raw constraint error. Audited.
--  (2) fn_admin_set_user_role: relax so a plain 'admin' can promote/demote between player<->marketer
--      ONLY (never create or touch admin/superadmin). superadmin+ keep full power. This lets brand
--      admins run their marketer programme without superadmin. Brand scope is enforced in the API
--      layer (assertTargetSiteInScope) exactly like the other admin mutations.
--
-- Cross-brand sign-in is deliberately NOT changed here: it remains platform_superadmin impersonation
-- so per-brand data isolation is preserved.

-- Normalise a Kenyan phone to local 0XXXXXXXXX (mirrors marketer_account_ids / game-withdraw logic).
create or replace function public.fn_norm_phone(p text)
returns text language sql immutable as $fn$
  select regexp_replace(btrim(coalesce(p,'')), '^\+?254', '0')
$fn$;

create or replace function public.fn_admin_update_user(
  p_actor uuid, p_actor_role text, p_target uuid, p_phone text, p_username text
) returns table(user_id uuid, phone text, username text)
language plpgsql security definer set search_path = public
as $fn$
declare v_site uuid; v_phone text; v_username text; v_cur record;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select pr.site_id, pr.phone, pr.username, pr.role into v_cur from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  -- A plain admin may not edit an admin/superadmin account.
  if p_actor_role = 'admin' and v_cur.role in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  v_site := v_cur.site_id;

  v_phone := nullif(public.fn_norm_phone(p_phone), '');
  v_username := nullif(btrim(coalesce(p_username, '')), '');

  if v_phone is not null then
    if v_phone !~ '^0[17][0-9]{8}$' then raise exception 'INVALID_PHONE'; end if;
    if exists (select 1 from public.profiles pr where pr.site_id = v_site and pr.phone = v_phone and pr.id <> p_target) then
      raise exception 'PHONE_TAKEN';
    end if;
  end if;
  if v_username is not null then
    if length(v_username) < 2 or length(v_username) > 40 then raise exception 'INVALID_USERNAME'; end if;
    if exists (select 1 from public.profiles pr where pr.site_id = v_site and lower(pr.username) = lower(v_username) and pr.id <> p_target) then
      raise exception 'USERNAME_TAKEN';
    end if;
  end if;

  update public.profiles pr
     set phone    = coalesce(v_phone, pr.phone),
         username = coalesce(v_username, pr.username)
   where pr.id = p_target
   returning pr.id, pr.phone, pr.username into user_id, phone, username;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.update_details', 'user', p_target::text,
            jsonb_build_object('phone', phone, 'username', username,
                               'old_phone', v_cur.phone, 'old_username', v_cur.username));
  return next;
end;
$fn$;

revoke all on function public.fn_admin_update_user(uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.fn_admin_update_user(uuid,text,uuid,text,text) to service_role;

-- Relaxed role setter: admin may promote/demote player<->marketer only; superadmin+ keep full power.
create or replace function public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
returns table(user_id uuid, role text)
language plpgsql security definer set search_path = public
as $function$
declare v_old text;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('player','marketer','admin','superadmin') then raise exception 'INVALID_ROLE'; end if;
  if p_role = 'superadmin' then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- A plain admin is confined to the player<->marketer transition (cannot mint admins or touch them).
  if p_actor_role = 'admin' and (p_role not in ('player','marketer') or v_old not in ('player','marketer')) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.profiles pr set role = p_role where pr.id = p_target;

  if p_role = 'marketer' then
    perform * from public.fn_affiliate_enroll(p_target);
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.set_role', 'user', p_target::text,
            jsonb_build_object('old', v_old, 'new', p_role));
  return query select p_target, p_role;
end;
$function$;
