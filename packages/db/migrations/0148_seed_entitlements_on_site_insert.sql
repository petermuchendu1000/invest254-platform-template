-- 0148_seed_entitlements_on_site_insert.sql — every NEW brand gets the free defaults (Issue 2 fix).
--
-- BUG: 0145 backfilled brand_entitlements only for brands that existed at migrate time. A brand created
-- afterwards (via /platform/onboard's raw insert, via fn_platform_create_site, or via SQL) had NO
-- entitlement rows, so the whole add-on model (brand view, chart/gateway locks) broke for new clients.
-- FIX: an AFTER INSERT trigger on sites seeds the category defaults (line / classic / mpesa) for the new
-- brand, regardless of the creation path. Idempotent (on conflict do nothing); additive.

create or replace function public.fn_seed_default_entitlements() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.brand_entitlements(site_id, category, key)
    select new.id, c.category, c.key from public.addon_catalog c where c.is_default
    on conflict (site_id, category, key) do nothing;
  return new;
end;
$fn$;

drop trigger if exists trg_seed_default_entitlements on public.sites;
create trigger trg_seed_default_entitlements after insert on public.sites
  for each row execute function public.fn_seed_default_entitlements();
