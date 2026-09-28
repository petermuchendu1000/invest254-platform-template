-- 0171_payhero_addon_catalog.sql — register PayHero in the add-on catalog (it was never there).
--
-- BUG: `payhero` exists in `payment_providers` (0130) and 13 brands already hold a
-- `brand_entitlements` row for it — but only because 0149's grandfather backfill inserted those rows
-- DIRECTLY, bypassing the catalog. `addon_catalog` never got a `payment_gateway/payhero` entry.
--
-- Consequence: `fn_addon_grant(..., 'payment_gateway', 'payhero')` raises ADDON_NOT_FOUND, so PayHero
-- cannot be granted to ANY brand through the supported path. A brand created after 0149 (the 0148
-- trigger seeds only `is_default` add-ons, i.e. M-Pesa) can be switched onto PayHero in
-- `site_payment_providers`, yet never entitled to it — and `listDepositProviders` intersects effective
-- providers with entitlements, so the brand is left with NO deposit method at all. `betyangu`
-- (created 2026-09-27) is in exactly that state.
--
-- FIX: add the catalog row, priced in line with the other non-default gateways. Idempotent and
-- additive: no entitlement is granted here and no brand is billed by this migration — the billing
-- trigger fires on `brand_entitlements` inserts, not on catalog rows.
begin;

insert into public.addon_catalog
  (category, key, display_name, description, price_cents, setup_fee_cents, billing_type, is_default, active, sort_order)
values
  ('payment_gateway', 'payhero', 'PayHero',
   'PayHero deposits (M-Pesa STK, plus card/bank via the hosted checkout).',
   1000000, 0, 'one_off', false, true, 50)
on conflict (category, key) do nothing;

commit;
