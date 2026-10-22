-- 0194_leaderboard_seed.sql — SEEDED rows for the public Top Traders board.
--
-- WHY: the real board is near-empty. `fn`-free and plainly: on a quiet brand
-- `sum(positions.pnl) > 0` leaves one or two names, and a leaderboard with one name on it reads
-- as a dead product to the person deciding whether to deposit.
--
-- This is the SECOND seed table, beside activity_seed (0193), and for the same reason that one
-- exists: the only safe place for invented rows is somewhere the books cannot see them. The board's
-- real source is `positions.pnl` — the money of record, which also feeds RTP monitoring, the daily
-- GGR report, the pool reconcile and the nightly provable-fairness recomputation. A fabricated
-- position would move every one of those numbers, and the fairness audit would FAIL on it, because
-- a hand-written position cannot be reproduced from seed + config_version + nonce. So nothing here
-- touches positions, transactions, wallets, ledger_entries or deposit_commissions, and no profile
-- is invented either: a synthetic `profiles` row would consume a paid subscription seat
-- (fn_enforce_user_quota, 0138), inflate the platform player count (0072) and come with a wallet
-- whose real_balance is withdrawable cash.
--
-- SHAPE: one row is a BUCKET of a seeded trader's activity at a point in time — some trades, some
-- winnings — not a single trade and not a whole-period total. The board aggregates
--     select name, sum(trades), sum(winnings_cents) ... where <window> group by name
-- which is the same shape as the real query over positions, so one period filter drives both
-- sources and a seeded trader's standing differs between Today and This Month exactly as a real
-- one's would. A per-period total could not do that, and a per-trade row would need thousands of
-- rows per name to look plausible.
--
-- RANKED BY WINNINGS, not by profit. The real board sums `pnl` (net), which is the honest metric
-- for real money and the reason it is near-empty. `winnings_cents` here is gross winnings, which is
-- what the product asked to rank by; the read path decides which metric it asks each source for.
--
-- Money-neutral and idempotent: no money table is touched and nothing here can affect a balance,
-- a report, a payout or a commission. The whole table can be TRUNCATEd at any moment and not one
-- real number changes.
begin;

create table if not exists public.leaderboard_seed (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references public.sites(id) on delete cascade,
  -- Already display-ready, exactly like activity_seed.name. Not a username, not an id: there is no
  -- account behind it, which is why the read path shows it verbatim instead of running it through
  -- publicName (that function exists to shrink a REAL player's handle to the least that still reads
  -- as a person, and there is no person here to protect).
  name           text   not null check (length(btrim(name)) between 1 and 40),
  -- How many settled trades this bucket stands for. Bounded so one row cannot invent a thousand.
  trades         int    not null default 1 check (trades between 1 and 500),
  -- Gross winnings in KES cents. Non-negative is a CHECK here, not a clamp in TypeScript, because
  -- activity_seed's amount_cents was left unchecked and that is a gap worth not repeating.
  winnings_cents bigint not null default 0 check (winnings_cents >= 0),
  -- Backdated (or post-dated) by the seeding script so buckets spread across the windows the board
  -- offers instead of all landing in one of them.
  created_at     timestamptz not null default now()
);

alter table public.leaderboard_seed enable row level security;
grant select, insert, update, delete on public.leaderboard_seed to service_role;

-- The read is always (one brand, one time window, newest-first): an exact prefix+order match, so
-- the board stays a bounded index scan however large the table grows.
create index if not exists ix_leaderboard_seed_site on public.leaderboard_seed(site_id, created_at desc);

comment on table public.leaderboard_seed is
  'SEEDED Top Traders rows. Not real trades and deliberately not in positions or any money table; '
  'safe to delete at any time without affecting any balance, report, payout, commission or the '
  'provable-fairness audit. Undo for one brand: '
  'delete from leaderboard_seed where site_id = (select id from sites where slug = ''<slug>'');';

commit;
