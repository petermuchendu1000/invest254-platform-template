-- 0082_platform_set_site_owner.sql — assign/change a brand's marketer (owner_user_id).
--
-- Powers the admin control for the site-owner commission model (0081). platform_superadmin only.
-- Validates the new owner is a MARKETER on that same brand (or NULL to clear). Audited.

create or replace function public.fn_platform_set_site_owner(
  p_actor uuid, p_actor_role text, p_site uuid, p_owner uuid
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_role text; v_osite uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  if p_owner is not null then
    select role, site_id into v_role, v_osite from public.profiles where id = p_owner;
    if not found then raise exception 'OWNER_NOT_FOUND'; end if;
    if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
    if v_osite <> p_site then raise exception 'OWNER_WRONG_SITE'; end if;
  end if;
  update public.sites set owner_user_id = p_owner, updated_at = now() where id = p_site returning * into v_row;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.set_site_owner', 'site', p_site::text,
            jsonb_build_object('owner_user_id', p_owner), p_site);
  return v_row;
end;
$fn$;

revoke all on function public.fn_platform_set_site_owner(uuid,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_platform_set_site_owner(uuid,text,uuid,uuid) to service_role;
