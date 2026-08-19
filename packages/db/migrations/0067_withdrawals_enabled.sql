-- 0067_withdrawals_enabled.sql — per-brand withdrawal kill switch (owner/admin override).
--
-- When false, EVERY withdrawal *initiation* for the site is refused at the single service entry
-- point (PaymentService.requestWithdrawal): both the marketer INSTANT game->mpesa transfer and the
-- normal player pending->approve->B2C request. This lets an owner/admin halt payouts instantly
-- during a system malfunction, or when continuing would exceed the daily withdrawal pool, WITHOUT a
-- redeploy. Admin approval of already-pending withdrawals remains a manual admin decision.
--
-- Additive + idempotent. Default TRUE preserves existing behaviour for every brand.
alter table public.sites add column if not exists withdrawals_enabled boolean not null default true;

-- Owner/admin toggle (audited), mirroring fn_admin_set_default_pool. A site-scoped admin may only
-- flip its own brand; platform admins are unrestricted — the API layer enforces that via the token's
-- site claim before calling this. SECURITY DEFINER so it works regardless of the API's DB role.
create or replace function public.fn_admin_set_withdrawals_enabled(
  p_actor uuid, p_actor_role text, p_site uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.sites set withdrawals_enabled = p_enabled, updated_at = now() where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'withdrawals.toggle', 'site', p_site::text,
            jsonb_build_object('withdrawals_enabled', p_enabled), p_site);
  return p_enabled;
end;
$fn$;
