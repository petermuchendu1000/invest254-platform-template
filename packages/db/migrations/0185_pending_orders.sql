-- 0185_pending_orders.sql — the orders a trader armed at a price, so a restart cannot lose them.
--
-- WHY: MetaTrader's chart menu is built around placing a pending order at the level you clicked
-- (`Sell Limit 1  219.306`), and its Trading submenu offers the same two types the cursor allows.
-- A pending order is an instruction to open a position WHEN the price reaches a level, not now.
-- The engine checks the level on every tick, exactly as it already checks a Stop Loss, and opens
-- the position through the same `fn_open_position` a market order uses.
--
-- The engine deploys on every merge to main, and a deploy restarts it. An order held only in
-- memory would therefore vanish between the moment a trader armed it and the moment the market
-- reached it — which is the whole of what a pending order is for. This table is what lets the
-- engine re-arm them on boot, the way `RecoveryService` re-arms open positions from 0183.
--
-- NOT part of the money path. Nothing here is an amount that settles: a row is an INSTRUCTION, and
-- the only thing it ever causes is a call to the same ten-argument `fn_open_position` every market
-- order makes, with the same stake, after this row has been deleted. `fn_open_position` and
-- `fn_settle_position` are both untouched. A row that fails to write leaves the trader without a
-- pending order, which is the behaviour before this migration; a row that fails to delete is
-- covered by the engine's own in-memory removal plus the `filled_position_id` stamp below, so a
-- replayed fill cannot open a second position.
--
-- numeric(18,5) for `trigger_price`: the same type as `entry_price` / `exit_price` (0180) and
-- `sl_price` / `tp_price` (0183), because a trigger IS a price on the same chart axis and must
-- round-trip against them without a second rounding rule.
--
-- No CHECK that the level sits on the correct side of the market. The side depends on the price at
-- the moment the order is placed, which this table cannot see, and the sides differ per kind. The
-- engine refuses a wrong-sided order before it ever gets here (`pendingLevelValid` in the shared
-- package, which the client calls too so the menu cannot offer one).
create table if not exists public.pending_orders (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references public.sites (id) on delete cascade,
  -- `profiles`, not `users`: this schema's account row is `public.profiles` (0004), which is what
  -- `positions.user_id` references and therefore the only table this can agree with.
  user_id          uuid not null references public.profiles (id) on delete cascade,
  -- MetaTrader's four: 'buyLimit' | 'sellLimit' | 'buyStop' | 'sellStop'. Text rather than an enum
  -- for the reason every other status column here is text: an enum needs its own migration to grow.
  kind             text not null,
  symbol           text not null,
  stake_cents      bigint not null check (stake_cents > 0),
  trigger_price    numeric(18,5) not null,
  -- The protective levels to arm the position WITH, carried so an order placed with a stop opens a
  -- position that already has one rather than one the trader must then protect by hand.
  sl_price         numeric(18,5),
  tp_price         numeric(18,5),
  duration_s       integer not null,
  created_at       timestamptz not null default now(),
  -- Set when the order filled, alongside the position it became. A filled row is kept rather than
  -- deleted so the History tab's ORDERS grid can show it as FILLED, which is what MetaTrader shows,
  -- and so a replay cannot open a second position for the same order.
  filled_at        timestamptz,
  filled_position_id uuid references public.positions (id) on delete set null,
  -- Set when the trader cancelled it. MetaTrader's CANCELED order state.
  canceled_at      timestamptz
);

/*
 * Row level security, with NO policy, which is what 0153 established for every table in `public`.
 *
 * Supabase grants `anon` and `authenticated` privileges on each new public table, so RLS is the
 * only thing between the public anon key and the rows. Enabling it with no policy denies every
 * row to those two roles, exactly as `positions` is; the engine reaches this table as
 * `service_role`, which bypasses RLS, and no browser ever queries it directly (it arrives over the
 * socket). A policy here would be a second, weaker way in for data that is nobody's but its owner's.
 */
alter table public.pending_orders enable row level security;

-- The only query the engine makes on boot and the only one the API makes per trader: the orders
-- still waiting. Partial, because a filled or cancelled row is never re-armed and the table is
-- append-mostly.
create index if not exists pending_orders_live_idx
  on public.pending_orders (site_id, user_id)
  where filled_at is null and canceled_at is null;

comment on table public.pending_orders is
  'Orders armed at a price, waiting for the market to reach them. The engine re-arms these on boot and checks them on every tick, then opens the position through the ordinary fn_open_position. Never part of the money path: a row is an instruction, not an amount.';
comment on column public.pending_orders.kind is
  'One of buyLimit, sellLimit, buyStop, sellStop. The trigger test per kind is pendingTriggered() in the shared package, which the engine and the client both call so a row cannot promise a fill the server would not make.';
comment on column public.pending_orders.filled_position_id is
  'The position this order became. Non-null with filled_at, and what stops a replayed fill opening a second position.';
