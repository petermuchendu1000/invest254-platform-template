-- 0188_site_country.sql — the country a brand collects payments in.
--
-- WHY: the PayX (Paynicorn) rail is per COUNTRY. Which payment methods exist — M-Pesa, a bank, a card —
-- is decided by the country the collection happens in, and so is the currency and how many decimals that
-- currency takes on the wire. Until now every PayX order was hard-coded to Kenya/KES, so a brand
-- anywhere else could not collect at all.
--
-- `sites.currency` is the brand's DISPLAY currency (what a player sees prices in) and is deliberately
-- left alone: cpfmarket displays USD while collecting in Kenya. Collection country is a different
-- question, so it gets its own column rather than overloading that one.
--
-- Money-neutral and idempotent. Defaults to 'KE' for every existing brand, which is exactly what they
-- all do today, so nothing changes until an operator sets a different country.
--
-- The allowed set mirrors Paynicorn's published Country and Currency Comparison Table
-- (apps/engine/src/paynicorncountries.ts). A code outside it could never resolve a currency, so the
-- constraint keeps an impossible value from reaching the payment path.
begin;

alter table public.sites add column if not exists country text not null default 'KE';

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_sites_country') then
    alter table public.sites add constraint ck_sites_country check (country in (
      -- Africa
      'KE','NG','UG','ET','GH','TZ','ZM','CM','SN','CI','ZA',
      -- Middle East & North Africa
      'EG','MA','LB','AE','KW','SA','QA','OM','BH','JO','IQ','TR',
      -- Asia
      'IN','PK','BD','ID','PH','MY','TH','CN',
      -- America
      'US'
    ));
  end if;
end
$c$;

comment on column public.sites.country is
  'ISO-3166 alpha-2 country this brand COLLECTS payments in (PayX). Distinct from `currency`, which is the display currency.';

commit;
