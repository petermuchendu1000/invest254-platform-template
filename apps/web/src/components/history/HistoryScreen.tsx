'use client';

import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { HistoryTabs } from '@/components/wallet/HistoryTabs';
import { MT5History } from '@/components/history/MT5History';
import { isTerminalScreen } from '@/lib/ui/terminalScreen';
import { useBrokerTerminalBrand } from '@/lib/ui/useBrandShell';

/**
 * A BROKER brand's History screen is MetaTrader's, not the site's generic tabs. Every other shell —
 * line/wave, candlestick, digits — and every marketer screen keeps the house tabs (Transactions /
 * Ledger / Trades). The candlestick and digits shells are deliberately NOT brokers: they used to land
 * here because the test read `chart_style` alone, which is a TradingView type for both of them.
 */
export function HistoryScreen() {
  const broker = useBrokerTerminalBrand();
  const { isMarketer } = useMarketerSkin();
  if (isTerminalScreen(broker, isMarketer)) {
    return <MT5History />;
  }
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-fg">History</h1>
      <HistoryTabs />
    </section>
  );
}
