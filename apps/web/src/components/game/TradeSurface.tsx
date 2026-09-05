'use client';

import { useEffect, useState } from 'react';
import { useBrand } from '@/lib/brand/BrandProvider';
import { PriceHeader } from '@/components/game/PriceHeader';
import { TickerStrip } from '@/components/game/TickerStrip';
import { GameCurve } from '@/components/game/GameCurve';
import { BetPanel } from '@/components/game/BetPanel';
import { DigitsTradeScreen } from '@/components/game/digits/DigitsTradeScreen';

/**
 * Chooses the trade layout for the current brand:
 *  - 'classic' (default): the rise/fall curve terminal (PriceHeader + ticker + chart + BetPanel).
 *  - 'digits': the Deriv-style binary/digits broker screen.
 *
 * The brand value (`brand.tradeUi`) is the source of truth once the per-client toggle is wired in
 * the platform console. A `?ui=digits` / `?ui=classic` query param (persisted to localStorage) is a
 * safe preview override so the layout can be trialled on any brand before flipping the real flag.
 */
export function TradeSurface() {
  const brand = useBrand();
  const [override, setOverride] = useState<string | null>(null);

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('ui');
      if (q) window.localStorage.setItem('pp:tradeUi', q);
      setOverride(q ?? window.localStorage.getItem('pp:tradeUi'));
    } catch {
      /* SSR / no window — fall back to the brand value */
    }
  }, []);

  const ui = override ?? brand.tradeUi ?? 'classic';

  if (ui === 'digits') return <DigitsTradeScreen />;

  return (
    <section className="flex h-full min-h-0 flex-col gap-2 md:gap-3">
      <PriceHeader />
      <TickerStrip />
      <div className="min-h-0 flex-1">
        <GameCurve />
      </div>
      <BetPanel />
    </section>
  );
}
