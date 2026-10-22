/**
 * Whether the chart follows the live edge, and how far it is zoomed, as arithmetic.
 *
 * ── The bug this exists to kill ──────────────────────────────────────────────────────────────────
 *
 * The chart used to arm a three-second timer on any wheel, pointerdown or touchstart anywhere on it
 * (the price axis included), and when the timer fired it called a "snap to live" that set a
 * HARD-CODED 120-bar window at the right edge. So zooming in to read one candle was undone three
 * seconds later, and the view came back at a zoom level the trader had never chosen. Worse, while
 * following, that same snap ran on every animation frame, which made the chart literally
 * un-zoomable: any manual range change was overwritten on the next frame.
 *
 * MetaTrader has no such timer. It has ONE setting, "Chart auto scroll", and one rule:
 *
 *   a NEW BAR scrolls the chart to the latest bar, if the chart was already showing the latest bar.
 *
 * Nothing about a gesture, nothing on a clock, and the zoom is never changed by it: the window
 * KEEPS ITS WIDTH and shifts by the bar that just appeared. Scroll back into history and the chart
 * stays there, because it is no longer showing the latest bar; scroll forward to the edge again and
 * following resumes on its own, because it is.
 *
 * That makes "following" a fact about the current view rather than a mode a gesture toggles, which
 * is why it is derived here instead of stored.
 */

/** Bars of slack: a view whose right edge is this close to the last bar counts as showing it. */
export const EDGE_SLACK_BARS = 2;

/** The empty space MetaTrader leaves to the right of the last bar. */
export const RIGHT_OFFSET_BARS = 3;

/** How far the toolbar's +/- may zoom, in visible bars. */
export const MIN_BARS = 8, MAX_BARS = 600;

export interface LogicalRange { from: number; to: number }

/**
 * Is this view showing the latest bar?
 *
 * Measured against the last bar's index rather than against the right offset, so the empty gap
 * MetaTrader leaves past the last candle does not count as being adrift from it.
 */
export function atLiveEdge(range: LogicalRange | null, barCount: number): boolean {
  if (range === null || barCount === 0) return true;
  return range.to >= barCount - 1 - EDGE_SLACK_BARS;
}

/** The width of a view, in bars, floored at one so a degenerate range cannot divide by zero. */
export const widthOf = (range: LogicalRange | null, fallback: number): number =>
  range === null ? fallback : Math.max(1, range.to - range.from);

/**
 * The window that shows the latest bar at this width.
 *
 * The WIDTH IS THE CALLER'S, which is the whole fix: it is whatever the trader last zoomed to, so
 * a new bar shifts the view by one bar and changes nothing else.
 */
export function liveWindow(barCount: number, width: number): LogicalRange {
  const to = barCount - 1 + RIGHT_OFFSET_BARS;
  return { from: to - Math.max(1, width), to };
}

/** A zoom level, clamped to what the chart will draw. */
export const clampBars = (bars: number): number =>
  Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(bars)));

/**
 * Zooming keeps the RIGHT edge fixed and moves the left one.
 *
 * MetaTrader zooms about the right edge of the view, so the newest bar stays where it is and the
 * history slides in and out behind it. Zooming about the centre instead moves the bar the trader is
 * looking at, which is the one thing a zoom must not do.
 */
export function zoomedWindow(range: LogicalRange | null, bars: number, barCount: number): LogicalRange {
  if (range === null) return liveWindow(barCount, bars);
  return { from: range.to - bars, to: range.to };
}
