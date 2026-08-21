-- 0095_pool_mode_default.sql — pool path becomes the DEFAULT brain for every brand (Issue 1).
--
-- WHAT:
--   1. Flip `sites.pool_mode` ON for every existing brand that is still on the statistical brain.
--      The pool controller (docs/25) already governs NON-marketer trades when pool_mode is true;
--      marketers stay pool-exempt on the statistical path with their overrides (decision F in
--      apps/engine/src/game.ts) — unchanged by this migration.
--   2. Change the column DEFAULT to true so every NEW brand (fn_platform_create_site) is born
--      into pool mode.
--   3. Add fn_admin_set_pool_mode: an audited superadmin toggle so a brand can be moved back to
--      the statistical brain (or re-enabled) from the admin Game Config screen without SQL.
--      The 0088 `trg_sites_notify` trigger fires pg_notify('sites_changed') on the pool_mode
--      update, so the engine's SitesStore picks the flip up live — no redeploy.
--
-- SAFETY: a brand in pool mode with an UNFUNDED day pays no wins (0064 auto-seeds each EAT day
-- from sites.default_daily_pool_cents; every production brand already carries a non-zero default,
-- verified 2026-08-21). Operators must keep the daily pool funded — the admin Game Config screen
-- surfaces the budget next to this toggle.
--
-- Additive + idempotent. Money-neutral (flag flip only; no ledger movement).

do $$
begin
  -- 1. Existing brands -> pool mode ON.
  update public.sites set pool_mode = true where pool_mode = false;

  -- 2. New brands default to pool mode.
  alter table public.sites alter column pool_mode set default true;
end
$$;

-- 3. Audited superadmin toggle (mirrors fn_admin_set_withdrawals_enabled, 0067).
create or replace function public.fn_admin_set_pool_mode(
  p_actor uuid, p_actor_role text, p_site uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.sites set pool_mode = p_enabled, updated_at = now() where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool_mode.toggle', 'site', p_site::text,
            jsonb_build_object('pool_mode', p_enabled), p_site);
  return p_enabled;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_admin_set_pool_mode(uuid,text,uuid,boolean) from public, anon, authenticated;
  grant  execute on function public.fn_admin_set_pool_mode(uuid,text,uuid,boolean) to service_role;
end
$g$;
