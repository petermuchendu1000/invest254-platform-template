-- 0135_platform_admin_theme.sql — let a platform_admin theme brands IN ITS OWN platform.
--
-- Consistency fix (Issue 1 follow-up): a platform admin can already rename / re-status / re-tune the
-- economy of its own brands (0134), but theming was still platform_superadmin-only. Branding is
-- squarely platform-admin territory, so authorise it the SAME scoped way — via fn_platform_site_in_scope
-- (system owner unrestricted; platform_admin only within its platform; everyone else NOT_AUTHORIZED).
-- Brand OWNERSHIP changes remain system-only (governance). Additive + idempotent (create-or-replace).
create or replace function public.fn_platform_set_site_theme(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_tokens jsonb
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites;
begin
  if p_tokens is null or jsonb_typeof(p_tokens) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  -- Authorise + platform-scope in one call (raises NOT_AUTHORIZED / PLATFORM_SCOPE_FORBIDDEN / SITE_NOT_FOUND).
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site_id);
  update public.sites u set theme_tokens = p_tokens, updated_at = now()
   where u.id = p_site_id returning * into v_row;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.theme', 'site', p_site_id::text,
            jsonb_build_object('tokens', p_tokens));
  return v_row;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_platform_set_site_theme(uuid,text,uuid,jsonb) from public, anon, authenticated;
  grant execute on function public.fn_platform_set_site_theme(uuid,text,uuid,jsonb) to service_role;
end $g$;
