-- 0149_grandfather_gateway_entitlements.sql — make the payments entitlement gate a NO-OP for existing
-- brands (Issue 2 production-safety).
--
-- Phase 2 makes listDepositProviders intersect the effective providers with brand_entitlements. 0145
-- only granted the mpesa default, so any brand that TODAY offers megapay/payhero (globally enabled or a
-- per-site override) would suddenly show only M-Pesa to players — a regression. This grandfathers every
-- brand to the gateways it currently offers, so turning on the gate changes nothing for existing brands;
-- only NEWLY added gateways require a system-admin grant. Idempotent (on conflict do nothing).
--
-- Runs once at migrate time against the CURRENT enabled state. New brands get mpesa via the 0148 trigger
-- and any extra gateway via the request/grant flow — exactly the intended lock.

insert into public.brand_entitlements (site_id, category, key)
  select s.id, 'payment_gateway', p.code
    from public.sites s
    cross join lateral public.fn_list_effective_providers(s.id) p
   where p.enabled = true
on conflict (site_id, category, key) do nothing;
