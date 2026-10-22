-- 0189_trade_ui_broker_candlestick.sql — two more trade-screen layouts on sites.trade_ui.
--
-- 0112 constrained trade_ui to ('classic','digits'). Two more layouts exist now:
--
--   'broker'      — the MetaTrader-style terminal (Market Watch, order ticket, Toolbox, chart
--                   toolbars). It is what this codebase has had all along, but only ever reachable
--                   INDIRECTLY: it rendered whenever sites.chart_style was a TradingView type.
--                   Naming it makes it selectable on its own, so a brand can wear the terminal
--                   without that being a side effect of which chart it bought.
--   'candlestick' — the new single-screen trading layout: chart on the left, a Trading Panel and a
--                   Live Chat / Top Traders / Tournaments rail on the right, four tabs on a phone.
--
-- PRESENTATION ONLY, exactly as 0111/0112 were: not one of these values reaches the price stream,
-- the money, or the game math. The money of record stays KES cents and a trade is the same
-- rise/fall contract whichever screen places it.
--
-- Additive and idempotent. No existing row changes: every brand keeps the trade_ui it has, and the
-- chart_style route into the terminal is untouched, so the candlestick brands that reach it today
-- (muchwins) reach it tomorrow.
begin;

do $$
begin
  alter table public.sites drop constraint if exists sites_trade_ui_chk;
  alter table public.sites
    add constraint sites_trade_ui_chk check (trade_ui in ('classic','digits','broker','candlestick'));
end $$;

-- Sellable like every other layout (insert-only: never clobber an admin-edited price on re-apply).
insert into public.addon_catalog (category, key, display_name, price_cents, is_default, sort_order) values
  ('trade_ui','broker','Broker terminal',0,false,30),
  ('trade_ui','candlestick','Candlestick trading screen',0,false,40)
on conflict (category, key) do nothing;

update public.addon_catalog set description = d.txt from (values
  ('trade_ui','broker','The full MetaTrader-style terminal: Market Watch, order ticket, Toolbox and chart toolbars.'),
  ('trade_ui','candlestick','A single-screen candlestick trading view: live chart, a buy/sell panel, and a live chat, top traders and tournaments rail.')
) as d(cat,k,txt)
where addon_catalog.category = d.cat and addon_catalog.key = d.k;

commit;
