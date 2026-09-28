-- 0172_platform_entitlements.sql — gateways (and other add-ons) are owned by the PLATFORM; brands inherit.
--
-- MODEL (owner decision): every platform gets Daraja (`mpesa`) free. Every other gateway is purchased.
-- A purchase belongs to the PLATFORM, so all of its brands may use it; a brand may ADDITIONALLY be granted
-- a gateway of its own. Configuration is unchanged and already scoped global -> platform -> site (0160),
-- so a brand can run the SAME gateway as its platform under DIFFERENT credentials simply by holding a
-- site-scoped `payment_provider_config` row.
--
-- BUG THIS FIXES: entitlement was brand-only, while 0149's grandfather backfill ran once. A brand created
-- afterwards receives only the `is_default` add-ons from the 0148 trigger (M-Pesa), so it could be switched
-- onto its platform's gateway yet never be entitled to it. listDepositProviders intersects effective
-- providers with entitlements, so such a brand is left with NO deposit method at all — `surewinfx`
-- (created 2026-09-26) has been unable to take a single deposit for this reason.
begin;

-- ── Platform-owned add-ons ───────────────────────────────────────────────────────────────────────
create table if not exists public.platform_entitlements (
  platform_id   uuid not null references public.platforms(id) on delete cascade,
  category      text not null check (category in ('chart','trade_ui','payment_gateway')),
  key           text not null,
  -- true = recognised as ALREADY owned (a pre-existing arrangement); never raises a billing charge.
  grandfathered boolean not null default false,
  granted_by    uuid references public.profiles(id),
  granted_at    timestamptz not null default now(),
  primary key (platform_id, category, key)
);
create index if not exists idx_platform_entitlements_platform on public.platform_entitlements(platform_id);
alter table public.platform_entitlements enable row level security;
revoke all on table public.platform_entitlements from anon, authenticated;
grant select, insert, update, delete on table public.platform_entitlements to service_role;

-- ── Billing: charge the PLATFORM once per purchased add-on (mirrors trg_billing_addon_charge) ────
create or replace function public.trg_billing_platform_addon_charge() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare a public.addon_catalog; v_exempt boolean;
begin
  if new.grandfathered then return new; end if;                        -- recognised as already owned
  select * into a from public.addon_catalog where category = new.category and key = new.key;
  if not found or a.is_default then return new; end if;                -- unknown, or free (Daraja)
  select coalesce(billing_exempt, false) into v_exempt from public.platform_subscriptions where platform_id = new.platform_id;
  if coalesce(v_exempt, true) then return new; end if;                 -- exempt, or no subscription yet
  if exists (select 1 from public.billing_charges c
              where c.platform_id = new.platform_id and c.site_id is null
                and c.source_ref = new.category || ':' || new.key and c.voided_at is null) then
    return new;                                                         -- already charged: never double-bill
  end if;
  if a.billing_type = 'one_off' and a.price_cents > 0 then
    insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, source_ref, created_by)
      values (new.platform_id, null, 'addon_one_off', a.display_name || ' (platform)', a.price_cents,
              new.category || ':' || new.key, new.granted_by);
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_billing_platform_addon_charge on public.platform_entitlements;
create trigger trg_billing_platform_addon_charge after insert on public.platform_entitlements
  for each row execute function public.trg_billing_platform_addon_charge();

-- ── Resolution: free default + what the PLATFORM owns + what THIS brand was granted ──────────────
create or replace function public.fn_site_entitled_gateways(p_site uuid)
returns text[] language sql stable security definer set search_path = public as $fn$
  select array(
    select distinct k from (
      select 'mpesa' as k                                              -- Daraja is free for every platform
      union
      select pe.key from public.platform_entitlements pe               -- inherited from the platform
        join public.sites s on s.platform_id = pe.platform_id
       where s.id = p_site and pe.category = 'payment_gateway'
      union
      select be.key from public.brand_entitlements be                  -- granted to this brand alone
       where be.site_id = p_site and be.category = 'payment_gateway'
    ) t);
$fn$;

-- ── Grant / revoke at platform level (SYSTEM admin only, audited) ────────────────────────────────
create or replace function public.fn_platform_addon_grant(
  p_actor uuid, p_actor_role text, p_platform uuid, p_category text, p_key text, p_grandfathered boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_active boolean;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  select active into v_active from public.addon_catalog where category = p_category and key = p_key;
  if v_active is null then raise exception 'ADDON_NOT_FOUND'; end if;
  if not v_active then raise exception 'ADDON_INACTIVE'; end if;
  insert into public.platform_entitlements(platform_id, category, key, grandfathered, granted_by)
    values (p_platform, p_category, p_key, coalesce(p_grandfathered, false), p_actor)
  on conflict (platform_id, category, key) do nothing;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.addon.grant', 'platform', p_platform::text,
            jsonb_build_object('category', p_category, 'key', p_key, 'grandfathered', coalesce(p_grandfathered, false)));
  return jsonb_build_object('platform_id', p_platform, 'category', p_category, 'key', p_key, 'entitled', true);
end;
$fn$;

create or replace function public.fn_platform_addon_revoke(
  p_actor uuid, p_actor_role text, p_platform uuid, p_category text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  delete from public.platform_entitlements where platform_id = p_platform and category = p_category and key = p_key;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.addon.revoke', 'platform', p_platform::text,
            jsonb_build_object('category', p_category, 'key', p_key));
  return jsonb_build_object('platform_id', p_platform, 'category', p_category, 'key', p_key, 'entitled', false);
end;
$fn$;

revoke all on function public.fn_platform_addon_grant(uuid,text,uuid,text,text,boolean) from public, anon, authenticated;
revoke all on function public.fn_platform_addon_revoke(uuid,text,uuid,text,text)        from public, anon, authenticated;
grant execute on function public.fn_platform_addon_grant(uuid,text,uuid,text,text,boolean) to service_role;
grant execute on function public.fn_platform_addon_revoke(uuid,text,uuid,text,text)        to service_role;

-- ── Backfill existing ownership (grandfathered ⇒ no billing charges) ─────────────────────────────
-- Each platform is credited with the gateways its brands already hold, so no existing brand loses
-- anything and FUTURE brands inherit instead of landing with no deposit rail at all.
--
-- EXCEPTION — PayHero propagates only on the owner's own platform (MUCHENDU). On any other platform a
-- brand-level `payhero` row is a 0149 grandfather artifact pending an invoicing decision, so it stays
-- brand-level and must NOT become a platform-wide grant (that brand keeps it; its siblings do not).
insert into public.platform_entitlements (platform_id, category, key, grandfathered)
  select distinct s.platform_id, be.category, be.key, true
    from public.brand_entitlements be
    join public.sites s on s.id = be.site_id
   where be.category = 'payment_gateway'
     and s.platform_id is not null
     and not (be.key = 'payhero' and s.platform_id <> '10000000-0000-0000-0000-000000000001')
on conflict (platform_id, category, key) do nothing;

commit;
