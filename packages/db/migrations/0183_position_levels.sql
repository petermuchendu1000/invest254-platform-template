-- 0183_position_levels.sql — the Stop Loss and Take Profit a trader set, so a restart cannot lose them.
--
-- WHY: the engine holds a continuous position's levels in memory and checks them on every tick. It
-- deploys on every merge to main, and a deploy restarts it. `RecoveryService` then re-arms every
-- open position from the database, which until now had no idea a stop had ever been set — so the
-- trader's stop silently vanished, and worse, the position was re-armed with `continuous: false`
-- and reverted to the committed step contract it was NOT opened under. The same trade was priced
-- one way before the restart and another way after it, and a loser that could be closed by hand
-- before could not be closed after. These two columns are what let recovery put the position back
-- exactly as it was.
--
-- NOT part of the money path, despite being read by settlement. Every caveat from 0180 still holds:
-- these are written by their own UPDATE after the atomic RPC has returned, so `fn_open_position`
-- keeps the ten-argument signature every caller uses and a failed stamp can never fail or alter a
-- trade. What they record is the trader's INSTRUCTION, not an amount: no settled figure is read from
-- here, and `fn_settle_position` is untouched. A stamp that does not land leaves exactly today's
-- behaviour (a level lost on restart), so this is strictly a recovery of information, never a new
-- way for a trade to go wrong.
--
-- numeric(18,5): the same type as `entry_price` / `exit_price` (0180), because a level IS a price on
-- the same chart axis and must round-trip against them without a second rounding rule.
--
-- Nullable with no default: NULL means "not set", which is MetaTrader's own empty state for these
-- fields and what every existing row means, so nothing needs backfilling.
--
-- No CHECK that the stop sits below the entry for a buy: MetaTrader validates a level against the
-- CURRENT price in the client, the sides swap with the position's direction, and a constraint here
-- would reject a legitimate modification made while the price moved. The engine checks the stop
-- first on every tick (see game.ts `levelHit`), which is where that rule belongs.
alter table public.positions
  add column if not exists sl_price numeric(18,5),
  add column if not exists tp_price numeric(18,5);

comment on column public.positions.sl_price is
  'Stop Loss level, as a price on the chart axis of the position''s own UTC day. Null = not set. Written by a separate UPDATE after the money RPC, never inside it (see migration 0180); read back only by crash recovery, never by fn_settle_position.';
comment on column public.positions.tp_price is
  'Take Profit level, as a price on the chart axis of the position''s own UTC day. Null = not set. Written by a separate UPDATE after the money RPC, never inside it (see migration 0180); read back only by crash recovery, never by fn_settle_position.';
