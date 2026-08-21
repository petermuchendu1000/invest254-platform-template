-- 0096_marketer_brand_name.sql — brand-specific M-PESA sender name on marketer confirmations.
--
-- WHAT / WHY:
--   The marketer wallet feed renders every game-winnings withdrawal as a real-looking M-PESA
--   "money received" SMS (apps/api/src/mpesa.ts + ledgerToTxDto). The sender ("from …") was
--   HARD-CODED to "INVEST254" for every brand, so a marketer on MADOLAR, 1000WINS, TAMU TRADERS,
--   etc. still saw "…received Ksh700.00 from INVEST254…". This breaks the per-brand illusion the
--   feed exists to create and leaks the platform's flagship brand across every white-label client.
--
--   Fix: surface each marketer's own brand name (sites.name) on the profile view so the API can use
--   it as the M-PESA sender. This is the source of truth already shown in the admin/brand UIs, so no
--   new config surface is introduced. A brand with no resolvable site (should never happen) yields
--   NULL and the API falls back to "Invest254" — behaviour-preserving for the default brand.
--
-- SAFETY: CREATE OR REPLACE VIEW keeps the EXACT existing columns in the SAME order and only APPENDS
--   `brand_name` at the end (Postgres requires this for replace). The join is a LEFT JOIN so a
--   marketer row is never dropped if its site is missing. Read-only, additive, idempotent,
--   money-neutral. Every consumer maps columns by name, so appending a column is safe.

create or replace view public.marketer_profiles as
select
  m.id,
  m.name,
  public.fn_first_name(m.name) as first_name,
  public.fn_initials(m.name)   as initials,
  m.phone,
  m.status,
  w.balance_cents,
  w.available_fuliza_cents,
  w.airtime_balance_cents,
  w.currency,
  w.updated_at as wallet_updated_at,
  m.created_at,
  m.site_id,
  s.name as brand_name
from public.marketers m
join public.marketer_wallets w on w.marketer_id = m.id
left join public.sites s on s.id = m.site_id;
