/**
 * The arithmetic of MetaTrader's swipe-left quick commands, apart from the component that draws it.
 *
 * Two thresholds and an axis, which is all the gesture is. They live here because they are the part
 * that can be wrong in a way no screenshot shows: a shortcut that fires on an ordinary swipe runs a
 * command the trader did not ask for, and an axis decided per move makes a diagonal flick do
 * nothing at all.
 *
 * MetaQuotes publishes no pixel figures for any of it, so what follows is chosen and defended here
 * rather than claimed as measured.
 */

/** The width of one icon in the bar, which is also what the row slides per command. */
export const SWIPE_ICON_W = 48;

/**
 * How far the finger travels before the bar is open.
 *
 * Under the 44px minimum tap target this app enforces on controls that move money, so a swipe is
 * never shorter than the thing it reveals; and far enough past the axis threshold that the gesture
 * is unambiguously horizontal by the time it counts.
 */
export const OPEN_AT = 36;

/** Enough movement to call a gesture a drag rather than a tap, and to settle its axis. */
export const AXIS_AT = 6;

/** How far past a fully open bar the shortcut sits. */
const BEYOND_BAR = 60;

/**
 * How far before MetaTrader's own shortcut fires the last command outright: "By dragging the menu
 * further to the left, you can immediately switch to [its] screen."
 *
 * Measured from the bar rather than fixed, because the bar is two icons on a Quotes row and five on
 * a position row. It has to sit BEYOND the open bar: a fixed figure short of the widest bar meant a
 * trader dragging that bar fully open tripped the shortcut just by reaching the last icon, and a
 * figure past the widest bar made the shortcut on a two-icon row a drag most of the way across the
 * screen.
 */
export const shortcutAt = (barWidth: number): number => barWidth + BEYOND_BAR;

/** The bar's width for a given number of commands. */
export const barWidthOf = (commands: number): number => commands * SWIPE_ICON_W;

/**
 * Which axis a gesture has taken, or null while it is still too small to tell.
 *
 * Decided ONCE and then held by the caller. Re-deciding it on every move made a diagonal flick
 * alternate between scrolling the list and dragging the row, and do neither.
 */
export function swipeAxis(dx: number, dy: number): null | 'x' | 'y' {
  if (Math.abs(dx) < AXIS_AT && Math.abs(dy) < AXIS_AT) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/**
 * What a finished horizontal gesture does.
 *
 * `dx` is signed, as the pointer reports it: left is negative, and a rightward drag on a closed row
 * is nothing at all, because there is no bar on that side to reveal.
 */
export function swipeOutcome(dx: number, barWidth: number): 'closed' | 'open' | 'shortcut' {
  const left = -dx;
  if (left >= shortcutAt(barWidth)) return 'shortcut';
  if (left >= OPEN_AT) return 'open';
  return 'closed';
}

/** How far the row is dragged while the finger is down: left only, and not past the shortcut. */
export const swipeOffset = (dx: number, barWidth: number): number =>
  Math.max(0, Math.min(shortcutAt(barWidth) + 40, -dx));
