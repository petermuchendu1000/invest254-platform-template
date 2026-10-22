/**
 * The arithmetic behind MetaTrader's Toolbox splitter, kept out of the component so it can be
 * tested on its own: the component is pointer plumbing, this is the rule.
 */

/** Below this the pane cannot show a row and its header; above it the chart stops being a chart. */
export const MIN_PANEL_PX = 120;
export const MIN_CHART_PX = 160;
/** The chrome above the chart (brand header, chart toolbar) that the pane cannot borrow from. */
export const CHROME_PX = 100;
/** MT5 keeps the chart the dominant pane. 68% is the cap the mobile sheet already used. */
export const MAX_PANEL_FRACTION = 0.68;

/**
 * Clamps a dragged pane height so neither pane can be destroyed:
 *  - the pane never drops under `MIN_PANEL_PX`, because a pane with no height reads as broken
 *    rather than as small;
 *  - the chart keeps `MIN_CHART_PX` whenever the screen can spare it;
 *  - the pane never takes more than `MAX_PANEL_FRACTION` of the viewport, so a drag cannot bury the
 *    chart behind the panel on a phone.
 *
 * On a screen too short to satisfy both minimums the pane's floor wins, and the chart scrolls.
 */
export function clampPanelHeight(desired: number, viewportPx: number): number {
  const room = viewportPx - CHROME_PX - MIN_CHART_PX;
  const max = Math.max(MIN_PANEL_PX, Math.min(Math.round(viewportPx * MAX_PANEL_FRACTION), room));
  return Math.min(max, Math.max(MIN_PANEL_PX, desired));
}
