-- 0087_ledger_demo_kind.sql — HOTFIX: allow the non-withdrawable 'demo' ledger kind (migration 0084).
--
-- 0084 introduced wallets.demo_balance and made the money RPCs write ledger_entries with
-- balance_kind='demo' for marketer/demo accounts, but ledger_entries_balance_kind_check only allowed
-- ('real','bonus') — so every marketer open/settle/withdraw now raises CheckViolation. This widens the
-- constraint to include 'demo'. Idempotent. (The same widening is also folded into 0084 for fresh installs.)
alter table public.ledger_entries drop constraint if exists ledger_entries_balance_kind_check;
alter table public.ledger_entries add constraint ledger_entries_balance_kind_check
  check (balance_kind = any (array['real'::text, 'bonus'::text, 'demo'::text]));
