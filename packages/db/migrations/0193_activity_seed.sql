-- 0193_activity_seed.sql — SEEDED social-proof rows for the trade screen's Live Chat feed.
--
-- WHY A SEPARATE TABLE. A brand that has just launched has a near-empty activity feed, and the
-- product owner wants the feed to look alive. The only safe way to do that is to keep the invented
-- rows somewhere the books cannot see them. Every row in this table is SEEDED social proof — a
-- name and an amount nobody actually deposited, withdrew or won — and it is deliberately NOT in
-- `transactions`, `positions`, `wallets` or `deposit_commissions`, because those tables are the
-- ledger: they feed balances, the daily reports, RTP monitoring and commission accrual. A fabricated
-- deposit there would move a real number, and no later clean-up could prove which numbers were
-- real. Here, nothing reads these rows but the public feed, so the whole table can be TRUNCATEd or
-- any subset DELETEd at any moment and not one balance, report, payout or commission changes.
--
-- The honest-feed note in `activity.pg.ts` still stands for the REAL arms of that query: they keep
-- reading only things that happened. This table is the one, clearly-labelled place where marketing
-- copy lives, kept apart precisely so the boundary between "happened" and "seeded" stays legible to
-- whoever reads the schema next.
--
-- `name` is stored ready to display (seed rows carry their own name and never go through
-- publicName — there is no account behind them to protect), and the index matches the feed's only
-- access path: newest-first within one brand.
--
-- Money-neutral and idempotent.
begin;

create table if not exists public.activity_seed (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  -- The same three kinds the real feed emits, so the client renders a seed row with no special case.
  kind        text not null check (kind in ('deposit','withdrawal','win')),
  -- Already display-ready. Not a username, not an id: nobody is behind it.
  name        text not null,
  amount_cents bigint not null default 0,
  -- Backdated by the seeding script so rows spread across the window instead of all landing "now".
  created_at  timestamptz not null default now()
);
alter table public.activity_seed enable row level security;
grant select, insert, update, delete on public.activity_seed to service_role;
create index if not exists ix_activity_seed_site on public.activity_seed(site_id, created_at desc);

comment on table public.activity_seed is
  'SEEDED social-proof rows for the public activity feed. Not real events and deliberately not in any money table; safe to delete at any time without affecting any balance, report or commission.';

commit;
