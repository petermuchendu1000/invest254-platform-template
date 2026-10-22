-- 0180_position_execution_price.sql — the chart price a trade actually executed at.
--
-- WHY: the engine's curve is unitless. A position stores `entry_rate` / `exit_rate`, which are curve
-- rates, while the terminal charts a PRICE: `price = base + scale × (value − dayOpenValue)`, where
-- `base` and `dayOpenValue` are re-anchored at every UTC midnight (see shared/candles.ts priceOf).
-- A rate therefore cannot be turned into the price it was shown at by anything holding the trade
-- alone — only by the engine's day chain. So every price slot on the MT5 History screen reads
-- "at market" rather than mapping an old rate through TODAY's anchor and printing a number that
-- never happened.
--
-- These two columns record the price at execution time, from the day's own anchor, so the receipt
-- stays true forever: it survives a curve-config change (CURVE_BASE_RATE / CURVE_AMPLITUDE) that
-- would otherwise silently rewrite the whole of history, and it needs no day-chain reconstruction
-- to read back.
--
-- NOT part of settlement. The money path (fn_open_position / fn_open_contract / fn_settle_position)
-- is untouched: these are written by a separate UPDATE after the atomic RPC has returned, so a
-- failure to stamp a display price can never fail or alter a trade. Both stay nullable for exactly
-- that reason — null means "not stamped", and the client falls back to "at market".
--
-- numeric(18,5): the same precision as entry_rate/exit_rate, which is five decimals more than any
-- instrument we quote (XAUUSD has 2), so rounding to the symbol's tick happens on the way in and
-- the stored number is never the thing that loses precision.

alter table public.positions
  add column if not exists entry_price numeric(18,5),
  add column if not exists exit_price  numeric(18,5);

comment on column public.positions.entry_price is
  'Display price the contract opened at, on the chart axis anchored to its OWN UTC day. Null = not stamped (client shows "at market"). Display-only; never read by settlement.';
comment on column public.positions.exit_price is
  'Display price the contract settled at, on the chart axis anchored to the UTC day it settled on. Null = not stamped. Display-only; never read by settlement.';
