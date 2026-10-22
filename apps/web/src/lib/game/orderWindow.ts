/**
 * Whether an order window is waiting for a result, so the same refusal is not answered twice.
 *
 * MetaTrader puts an execution result "in the window" the order was sent from. Where there IS such
 * a window and it is waiting, a popup saying the same thing is a second answer to one tap; where
 * there is not — the one-click panel firing instantly, the desktop shell — the popup is the only
 * surface a rejection has, and it must still appear.
 *
 * A module-level counter rather than state, because the socket handler reads it from inside a
 * closure installed once, and React state read from there would be whatever it was at install time.
 * Counted rather than a boolean: the classic ticket and the advanced dialog can both be mounted
 * while one of them is mid-order, and the first to finish must not clear the other's claim.
 */
let waiting = 0;

/** An order has gone out from a window that will show its result. Returns the release. */
export function claimOrderWindow(): () => void {
  waiting += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    waiting = Math.max(0, waiting - 1);
  };
}

/** True while at least one window is waiting to print a result itself. */
export const orderWindowWaiting = (): boolean => waiting > 0;

/** Test seam: there is no component lifecycle in a unit test to unwind the counter. */
export function resetOrderWindows(): void {
  waiting = 0;
}
