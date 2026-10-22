'use client';

import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { useBrand } from '@/lib/brand/BrandProvider';
import { isBrokerTerminalBrand, presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

/**
 * The two brand-shell questions, asked once instead of re-derived at every call site.
 *
 * `tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null` was written out in full at thirteen
 * places, and that duplication is exactly how they drifted: the trade surface was updated to the
 * correct rule (`isBrokerTerminalBrand`, which excludes the candlestick and digits shells) and the
 * other twelve were not. The result was that a `trade_ui='candlestick'` brand got its own shell on
 * the trade screen and MetaTrader's screens everywhere else — History, Account, the bottom nav, the
 * toasts — and a digits brand got MetaTrader's too, because `chart_style='area'` is a TradingView
 * type. Asking through these hooks makes that class of drift impossible.
 */

/**
 * Does this brand wear the BROKER terminal (MetaTrader chrome, its History/Settings screens, its
 * drawer in place of the bottom nav)? Candlestick and digits brands are NOT brokers.
 */
export function useBrokerTerminalBrand(): boolean {
  const brand = useBrand();
  return isBrokerTerminalBrand(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null);
}

/**
 * Does this brand's COPY speak the trading register (traders, trading) rather than the gaming one
 * (players, play)? Broker and candlestick do; classic and digits do not. See
 * `presentsAsTradingProduct` — chrome and vocabulary are deliberately different questions.
 */
export function useTradingRegisterBrand(): boolean {
  const brand = useBrand();
  return presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null);
}
