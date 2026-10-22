'use client';

import { useEffect, useState } from 'react';
import { TRADE_UIS, type TradeUi } from '@invest254/shared/chart';

/**
 * Every trade-screen layout a brand can wear, from the ONE list (packages/shared/chart).
 *
 * It was a second copy here. The API kept a third, as a ternary that collapsed anything newer than
 * `digits` to `classic`, so a brand set to `candlestick` in the database was served `classic` — the
 * reason this is now imported rather than written out again.
 */
export { TRADE_UIS, type TradeUi } from '@invest254/shared/chart';

/** Is this one of the layouts we actually have? Guards a query param and a database value alike. */
export const isTradeUi = (v: unknown): v is TradeUi => (TRADE_UIS as readonly unknown[]).includes(v);

/**
 * The layout to render: the preview override if there is a valid one, else the brand's own, else
 * the default.
 *
 * Pure, because two places have to agree on it — the screen and the shell around it — and a
 * disagreement is not a subtle bug: it renders the new screen inside the old header. An unknown
 * value falls back rather than throwing, since it can come from a URL anyone can type.
 */
export function resolveTradeUi(override: string | null | undefined, brandValue: string | null | undefined): TradeUi {
  if (isTradeUi(override)) return override;
  if (isTradeUi(brandValue)) return brandValue;
  return 'classic';
}

const KEY = 'pp:tradeUi';

/**
 * The `?ui=` preview override, persisted so it survives a navigation.
 *
 * It exists so a layout can be trialled on any brand before the flag is flipped for real players.
 * Null until the client has mounted — the server has no query string and no localStorage, so a
 * first paint that guessed would be a hydration mismatch on every brand.
 */
export function useTradeUiOverride(): string | null {
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('ui');
      if (q) window.localStorage.setItem(KEY, q);
      setOverride(q ?? window.localStorage.getItem(KEY));
    } catch {
      /* SSR / no window / blocked storage — the brand's own value stands */
    }
  }, []);
  return override;
}
