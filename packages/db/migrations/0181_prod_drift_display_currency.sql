-- 0181_prod_drift_display_currency.sql — DRIFT-1 reconcile: adopt profiles.display_currency.
--
-- WHAT THE GATE FOUND. The schema-drift job (scripts/schema_drift.mts) has failed every run since
-- 2026-09-28 with exactly one difference:
--
--     only-production  column  profiles.display_currency  [prod=text]
--
-- Production carries a `text` column on `profiles` that NO migration creates. It is the second
-- out-of-band change this gate has caught (the first was 0158, 2026-09-23).
--
-- WHAT IT IS. Nothing in this repository mentions `display_currency` — not a migration, not a line
-- of TypeScript. The feature it was evidently meant for, a saved per-user display currency (#10
-- geo-currency), shipped WITHOUT any database column: the choice lives in the `pp-currency` cookie,
-- the server layout reads it, and the API takes it as the `currency` query parameter on
-- /site/brand, where `resolveDisplayCurrency` ranks preference → geo → brand default. So the column
-- is an orphan from an approach that was abandoned before it was wired up.
--
-- WHY THIS ADOPTS IT RATHER THAN DROPPING IT. Dropping is the tidier end state and 0158 did drop
-- objects — but only ones that were pure code (unused function overloads). This is a column, so a
-- DROP destroys whatever its rows hold, irreversibly, and no one preparing this change could read
-- production to find out whether it is empty or full. Adopting costs one dead column and closes the
-- drift today; dropping cannot be undone and cannot currently be justified with evidence. The drop
-- stays available as a follow-up once someone with database access confirms the column is unused:
--
--     select count(*) as populated from public.profiles where display_currency is not null;
--     -- 0 rows → safe to drop in a later migration:
--     -- alter table public.profiles drop column display_currency;
--
-- Also note the gate compares a column by DATA TYPE only (data_type + character_maximum_length), so
-- `text` here matches production's `text` whatever its nullability or default — the drift closes on
-- the type alone. The column is left nullable with no default, which is the weakest claim this
-- migration can make about a column it is only adopting.
--
-- Idempotent: `if not exists` makes this a no-op on production, where the column already stands, and
-- a creation on a fresh build. Both sides end identical, which is the whole point.

alter table public.profiles
  add column if not exists display_currency text;

comment on column public.profiles.display_currency is
  'ORPHAN (adopted by 0181, DRIFT-1). Added to production out of band around 2026-09-28; no code reads or writes it. The live per-user display currency is the pp-currency cookie resolved by resolveDisplayCurrency, not this column. Safe to drop once confirmed empty.';
