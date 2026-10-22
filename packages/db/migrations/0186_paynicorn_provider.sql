-- 0186_paynicorn_provider.sql — register Paynicorn (hosted cashier) as a deposit gateway.
--
-- WHY: `fn_create_deposit_provider` refuses any provider missing from `payment_providers`
-- (PROVIDER_NOT_FOUND), and `fn_addon_grant` refuses any gateway missing from `addon_catalog`
-- (ADDON_NOT_FOUND — the 0171 PayHero bug). Paynicorn needs both rows before a brand can be entitled
-- to it, switched on for it, or create a single deposit through it.
--
-- Money-neutral and idempotent: the provider is registered OFF for every brand (enabled_global=false,
-- no site override), no entitlement is granted, and no brand is billed — the billing trigger fires on
-- `brand_entitlements` inserts, not on catalog rows. Credentials live in `payment_provider_config`
-- (0130), set from the Gateway configuration console, never here.
begin;

insert into public.payment_providers(code, display_name, enabled_global, sort_order)
values ('paynicorn', 'Paynicorn', false, 60)
on conflict (code) do nothing;

insert into public.addon_catalog
  (category, key, display_name, description, price_cents, setup_fee_cents, billing_type, is_default, active, sort_order)
values
  ('payment_gateway', 'paynicorn', 'Paynicorn',
   'Paynicorn deposits through its hosted checkout page.',
   1000000, 0, 'one_off', false, true, 60)
on conflict (category, key) do nothing;

commit;
