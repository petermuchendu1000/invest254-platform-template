-- 0145_brand_entitlements.sql — which "systems" each brand OWNS, and system-admin grant/revoke (Issue 2).
--
-- brand_entitlements records the add-ons a brand is entitled to. Every existing brand is backfilled with
-- its category DEFAULTS (line chart, classic trade UI, M-Pesa gateway) so nothing changes on apply. Only
-- the SYSTEM ADMIN (platform_superadmin) grants/revokes. Granting a chart/trade_ui ALSO sets it active on
-- the brand (the "assign" action) — the active system is system-admin-controlled (owners only request).
-- Additive + idempotent. Requests + the brand catalog view live in 0146; the chart CHECK is widened in 0147.

create table if not exists public.brand_entitlements (
  site_id     uuid not null references public.sites(id) on delete cascade,
  category    text not null check (category in ('chart','trade_ui','payment_gateway')),
  key         text not null,
  granted_by  uuid references public.profiles(id),
  granted_at  timestamptz not null default now(),
  primary key (site_id, category, key)
);
create index if not exists idx_brand_entitlements_site on public.brand_entitlements(site_id);
alter table public.brand_entitlements enable row level security;

-- Backfill: every brand owns the free default of each category (line / classic / mpesa) -> zero day-one change.
insert into public.brand_entitlements (site_id, category, key)
  select s.id, c.category, c.key
    from public.sites s cross join public.addon_catalog c
   where c.is_default
on conflict (site_id, category, key) do nothing;

-- ── Entitled payment gateways for a brand (always includes the mpesa default). Payments enforcement. ──
create or replace function public.fn_site_entitled_gateways(p_site uuid)
returns text[] language sql stable security definer set search_path = public as $fn$
  select array(
    select distinct k from (
      select key as k from public.brand_entitlements where site_id = p_site and category = 'payment_gateway'
      union select 'mpesa'
    ) t);
$fn$;

-- ── Grant (SYSTEM admin only): entitle a brand to an add-on; for chart/trade_ui also set it ACTIVE. ──
create or replace function public.fn_addon_grant(
  p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_active boolean;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  select active into v_active from public.addon_catalog where category = p_category and key = p_key;
  if v_active is null then raise exception 'ADDON_NOT_FOUND'; end if;
  if v_active = false then raise exception 'ADDON_INACTIVE'; end if;

  insert into public.brand_entitlements(site_id, category, key, granted_by)
    values (p_site, p_category, p_key, p_actor)
    on conflict (site_id, category, key) do update set granted_by = excluded.granted_by, granted_at = now();

  -- The active chart/trade UI is system-admin-assigned (owners only request). Granting sets it active.
  if p_category = 'chart'    then update public.sites set chart_style = p_key where id = p_site; end if;
  if p_category = 'trade_ui' then update public.sites set trade_ui  = p_key where id = p_site; end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.grant', 'site', p_site::text,
            jsonb_build_object('category', p_category, 'key', p_key), p_site);
  perform pg_notify('brand_entitlements_changed', p_site::text);
  return jsonb_build_object('site_id', p_site, 'category', p_category, 'key', p_key, 'entitled', true);
end;
$fn$;

-- ── Revoke (SYSTEM admin only): remove an entitlement; never a default; reset active to default if needed. ──
create or replace function public.fn_addon_revoke(
  p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_default text;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  select key into v_default from public.addon_catalog where category = p_category and is_default limit 1;
  if p_key = v_default then raise exception 'CANNOT_REVOKE_DEFAULT'; end if;
  delete from public.brand_entitlements where site_id = p_site and category = p_category and key = p_key;
  -- If the revoked system was active, fall back to the category default.
  if p_category = 'chart'    then update public.sites set chart_style = v_default where id = p_site and chart_style = p_key; end if;
  if p_category = 'trade_ui' then update public.sites set trade_ui  = v_default where id = p_site and trade_ui  = p_key; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.revoke', 'site', p_site::text,
            jsonb_build_object('category', p_category, 'key', p_key), p_site);
  perform pg_notify('brand_entitlements_changed', p_site::text);
  return jsonb_build_object('site_id', p_site, 'category', p_category, 'key', p_key, 'entitled', false);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_site_entitled_gateways(uuid)                 from public, anon, authenticated;
  revoke all on function public.fn_addon_grant(uuid,text,uuid,text,text)         from public, anon, authenticated;
  revoke all on function public.fn_addon_revoke(uuid,text,uuid,text,text)        from public, anon, authenticated;
  grant execute on function public.fn_site_entitled_gateways(uuid)               to service_role;
  grant execute on function public.fn_addon_grant(uuid,text,uuid,text,text)       to service_role;
  grant execute on function public.fn_addon_revoke(uuid,text,uuid,text,text)      to service_role;
  grant select, insert, update, delete on public.brand_entitlements to service_role;
end
$g$;
