'use client';

import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { isTerminalScreen } from '@/lib/ui/terminalScreen';
import { useBrokerTerminalBrand } from '@/lib/ui/useBrandShell';

/**
 * Does this screen wear MetaTrader's chrome?
 *
 * True on a candlestick brand, never on a marketer screen — the rule in `isTerminalScreen`, with the
 * brand and skin lookups it needs. It was being written out in full at every call site, which is how
 * one of them eventually gets the marketer half wrong.
 */
export function useTerminalSkin(): boolean {
  const broker = useBrokerTerminalBrand();
  const { isMarketer } = useMarketerSkin();
  return isTerminalScreen(broker, isMarketer);
}
