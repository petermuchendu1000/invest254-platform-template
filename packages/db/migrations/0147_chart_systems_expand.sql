-- 0147_chart_systems_expand.sql — widen the price-chart catalog on sites.chart_style (Issue 2).
--
-- 0111 constrained chart_style to ('line','candlestick'). Issue 2 treats each chart type as its own
-- sellable "system": line (free default), area, candlestick, bars, baseline. Widen the CHECK so the
-- system admin can assign any of them via fn_addon_grant (0145). All existing values (line/candlestick)
-- remain valid, so no row is invalidated. trade_ui stays ('classic','digits') — unchanged.
--
-- Enforcement that ONLY the system admin assigns chart_style/trade_ui is at the API boundary (the
-- service-role RPCs aren't reachable by operators; the platform site-patch endpoint strips these keys
-- for non-system-admins) + the addon-grant path. This migration only relaxes the value domain.

do $$
begin
  alter table public.sites drop constraint if exists sites_chart_style_chk;
  alter table public.sites
    add constraint sites_chart_style_chk check (chart_style in ('line','area','candlestick','bars','baseline'));
end $$;
