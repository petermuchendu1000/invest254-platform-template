-- 0182: record WHICH instrument a position was traded on.
--
-- Every history screen prints the one symbol the terminal quotes, because the trade record has
-- never carried its own. Market Watch now quotes eight symbols and a chart opens on any of them, so
-- that is visibly wrong even though every trade still settles on the brand's default instrument.
--
-- Deliberately NOT part of the money path. The symbol is written by a separate UPDATE after the
-- atomic RPC returns, exactly as `entry_price` / `exit_price` are (0180), so `fn_open_position`
-- keeps the ten-argument signature every caller uses. Adding a defaulted parameter to that function
-- instead would create an overload and make the engine's existing call ambiguous
-- ("function public.fn_open_position(...) is not unique"), which breaks every trade.
--
-- Nullable with no default and no CHECK:
--   * NULL means "the brand's own symbol", which is what every existing row means and what every
--     screen already renders, so nothing needs backfilling and an unstamped row stays
--     distinguishable from a stamped one.
--   * the symbol catalogue lives in code (packages/shared/src/symbols.ts, ~96 instruments), so a
--     CHECK constraint here would need a migration every time one is added.
alter table public.positions add column if not exists symbol text;

comment on column public.positions.symbol is
  'Instrument this position was traded on. NULL means the brand''s default symbol. Written by a separate UPDATE after the money RPC, never inside it (see migration 0180).';
