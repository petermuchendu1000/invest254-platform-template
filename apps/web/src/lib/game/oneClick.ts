'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { quoteTone, type QuoteToneInput } from './quoteTone.js';

/**
 * MetaTrader's mobile one-click trading panel: the state it is in, and the colour it is.
 *
 * The panel is `[ SELL \n price ]  [ ⌄ volume ⌃ ]  [ BUY \n price ]` directly under the chart's top
 * bar, or along the bottom edge where "One Click panel at the bottom" (Android: "Trading Panel at
 * the Bottom") is switched on. It is documented on both platforms with that exact layout; see
 * docs/mt5/04-mobile-app.md section 3.
 *
 * ── THE COLOUR, which is the part worth reading ───────────────────────────────────────────────────
 *
 * Both blocks are the SAME colour at any moment. Not red for sell and blue for buy: in every
 * official MetaQuotes screenshot of this panel, on both platforms, SELL and BUY are the same flat
 * red — sampled #D85852 on Android (`android/en/chart.png`, `android/en/one_click_trading.png`) and
 * #D54A36 on iOS (`iphone/en/one_click_trading.png`), over a thousand-odd pixels each.
 *
 * That only makes sense if the panel is tinted by the LAST TICK'S DIRECTION rather than by side,
 * which is also what a third-party guide says of it ("A red panel means that the current currency
 * quotation is lower than the previous one"). MetaQuotes publishes no screenshot of the other
 * state and no sentence describing it, so:
 *
 *   - the red is a MEASURED value and is used verbatim;
 *   - the up state is an INFERENCE. Its blue is the one MetaQuotes does document for "the current
 *     price is higher than the previous one" — the Market Watch quote blue, #3183ff — rather than a
 *     hex invented to sit beside the measured red.
 *
 * Copying this means the two sides of the panel are not told apart by colour, which looks like a
 * bug and is not: the words SELL and BUY sit in each block's top-left corner, large, which is how
 * MetaTrader's own panel is read. The order ticket keeps MetaTrader's blue-buy/red-sell pair,
 * because that is what MetaTrader's ticket does.
 */
export type OneClickTint = 'up' | 'down';

/** Android's measured fill, used for the down state on both. iOS's is #D54A36; one value, not two. */
export const ONE_CLICK_FILL: Record<OneClickTint, string> = {
  up: '#3183ff',
  down: '#D85852',
};

/**
 * Which way the panel is tinted.
 *
 * Anything that is not a live up-tick is red, which covers the three cases MetaQuotes' screenshots
 * show red in: a down tick, a price that has stopped moving, and a panel that has not had a quote
 * yet. `quoteTone` is the same staleness rule Market Watch uses, so the panel and the watch list
 * cannot disagree about whether the feed is moving.
 */
export const oneClickTint = (input: QuoteToneInput): OneClickTint =>
  quoteTone(input) === 'up' ? 'up' : 'down';

/**
 * Whether the panel is showing, and whether a tap on it fires immediately.
 *
 * Both are MetaTrader's: the `▭` button in the chart's top bar shows and hides the panel, and the
 * "One Click Trading" setting decides whether BUY/SELL send an order straight away or open the
 * trading dialog ("If 'One Click Trading' is off in settings, tapping BUY/SELL opens the trading
 * dialog instead of firing immediately").
 *
 * The panel defaults to SHOWING, because a phone chart with no way to trade from it is not what
 * this product is; one-click firing defaults to OFF, which is MetaTrader's own default and the only
 * safe one — a mis-tap on a 360px screen would otherwise be a live order.
 */
interface OneClickState {
  /** The `▭` toggle: is the panel on the chart? */
  shown: boolean;
  /** MetaTrader's "One Click Trading" setting: does a tap fire, or open the ticket? */
  instant: boolean;
  setShown: (shown: boolean) => void;
  setInstant: (instant: boolean) => void;
}

const SHOWN_KEY = 'pp-oneclick-shown';
const INSTANT_KEY = 'pp-oneclick-instant';

const write = (key: string, value: boolean): void => {
  try { window.localStorage.setItem(key, value ? '1' : '0'); }
  catch { /* blocked storage: the setting still holds for this session */ }
};

export const useOneClickStore = create<OneClickState>()((set) => ({
  shown: true,
  instant: false,
  setShown: (shown) => { write(SHOWN_KEY, shown); set({ shown }); },
  setInstant: (instant) => { write(INSTANT_KEY, instant); set({ instant }); },
}));

/** Restored after mount, for the house reason: a store seeded from storage during the server render
 *  is a hydration mismatch. */
export function useRestoreOneClick(): void {
  useEffect(() => {
    try {
      const shown = window.localStorage.getItem(SHOWN_KEY);
      const instant = window.localStorage.getItem(INSTANT_KEY);
      useOneClickStore.setState({
        ...(shown === null ? {} : { shown: shown === '1' }),
        ...(instant === null ? {} : { instant: instant === '1' }),
      });
    } catch { /* ignore */ }
  }, []);
}
