-- 0125_default_marketer_impersonation_scope.sql — let the platform owner manage a brand's default
-- marketer while IMPERSONATING that brand (BUGLOG #28).
--
-- Bug: fn_admin_set_site_owner (0104/0124) fenced the actor by their OWN profiles.site_id. That is
-- correct for a real per-brand admin (their profile brand == the brand they operate). But the platform
-- owner impersonates a client brand with a token minted as role='superadmin', site=<that brand> (the
-- SUBJECT stays the owner for audit — docs/24 §370). So p_actor is the owner (home brand = the
-- platform's own site), while the brand being acted on is the impersonated one. The RPC's actor-home
-- check therefore raised SITE_SCOPE_FORBIDDEN on EVERY make-/clear-default while impersonating any
-- brand other than the owner's home — i.e. the admin-panel default-marketer control (Issue 1) was
-- unreachable via impersonation, the exact way the operator uses it.
--
-- Fix: the impersonation fence is already enforced at the API/token layer (every make-/clear-default
-- route calls ensureUserInScope -> assertTargetSiteInScope, which scopes to the TOKEN's `site` claim).
-- The RPC's extra actor-home check only needs to fence a REAL per-brand admin/superadmin; a
-- platform-owner ACTOR (by profile role) is inherently cross-brand and must not be fenced by their
-- home site. So: skip the actor-home fence when the actor's PROFILE role is platform_superadmin.
--   * real admin/superadmin  -> unchanged (fenced to their own brand — defence in depth preserved);
--   * platform owner (native, actor_role='platform_superadmin') -> already skipped this block entirely;
--   * platform owner impersonating (actor_role='superadmin', profile='platform_superadmin') -> now
--     NOT home-fenced here; the token-scoped API guard remains the authority for which brand they act on.
-- The RPC still validates the marketer is an ACTIVE marketer on the (derived) site for ASSIGN, and
-- clears for any current owner. Same signature (4-arg): CREATE OR REPLACE, no call-site change, no
-- deploy window. Additive & idempotent; money math unchanged.

create or replace function public.fn_admin_set_site_owner(
  p_actor uuid, p_actor_role text, p_marketer uuid, p_make_default boolean
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_role text; v_status text; v_target_site uuid; v_site uuid;
        v_actor_site uuid; v_actor_role text;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select role, status, site_id into v_role, v_status, v_target_site from public.profiles where id = p_marketer;
  if not found then raise exception 'OWNER_NOT_FOUND'; end if;

  if p_make_default then
    -- ── ASSIGN ── the target must be an ACTIVE marketer on their own brand.
    if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
    v_site := v_target_site;
    if not exists (select 1 from public.sites where id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
    if p_actor_role in ('admin','superadmin') then
      select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
      -- A platform-owner actor (even via an impersonation superadmin token) is cross-brand; the
      -- token-scoped API guard fences impersonation. Only a REAL per-brand admin is home-fenced here.
      if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
        raise exception 'SITE_SCOPE_FORBIDDEN';
      end if;
    end if;
    if v_status <> 'active' then raise exception 'OWNER_NOT_ACTIVE'; end if;
    update public.sites set owner_user_id = p_marketer, updated_at = now() where id = v_site returning * into v_row;
  else
    -- ── CLEAR ── remove this user as the default of whatever brand they currently own, regardless of
    --    their current role/status. Cleared brand derived from the ownership row itself.
    select id into v_site from public.sites where owner_user_id = p_marketer;
    if not found then
      v_site := v_target_site;
      if p_actor_role in ('admin','superadmin') then
        select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
        if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
          raise exception 'SITE_SCOPE_FORBIDDEN';
        end if;
      end if;
      select * into v_row from public.sites where id = v_site;
    else
      if p_actor_role in ('admin','superadmin') then
        select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
        if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
          raise exception 'SITE_SCOPE_FORBIDDEN';
        end if;
      end if;
      update public.sites set owner_user_id = null, updated_at = now() where id = v_site returning * into v_row;
    end if;
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
