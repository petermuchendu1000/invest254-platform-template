'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useDisplayMoney } from '@/lib/money';
import { useStakeLimits } from '@/lib/game/useStakeLimits';
import { useCandlestickUi } from '@/components/game/candlestick/ui';

/**
 * The top bar's "How to Trade" sheet.
 *
 * It describes THIS product's contract, not the mock's: an amount, a side, and a fixed time after
 * which the engine settles it. The digits screen has its own version for its own contracts; sharing
 * one would mean a screen explaining rules it does not run.
 *
 * The figures are read from the brand's own config rather than written into the copy, because a
 * help sheet quoting a stake floor the brand does not use is worse than no help sheet.
 */
export function HowToModal() {
  const open = useCandlestickUi((s) => s.howToOpen);
  const setOpen = useCandlestickUi((s) => s.setHowTo);
  const brand = useBrand();
  const limits = useStakeLimits();
  const { both } = useDisplayMoney();
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const seconds = config?.defaultDurationS ?? 10;
  const sections = [
    { title: 'Placing a trade', body: `Type an amount, or tap one of the quick amounts, then choose a side. BUY wins if the price is higher when the trade closes; SELL wins if it is lower.` },
    { title: 'When it closes', body: `A trade closes on its own ${seconds} seconds after it opens. You do not have to watch it — the result is applied to your balance either way.` },
    { title: 'Your stake', body: `The amount is taken from your balance when the trade opens${limits.ready ? `, and must be between ${both(limits.minCents)} and ${limits.maxCents !== undefined ? both(limits.maxCents) : 'the brand maximum'}` : ''}. If the trade wins, the stake and the profit are credited back; if it loses, the stake is gone.` },
    { title: 'The chart', body: 'Each candle covers one minute: the body runs from the opening price to the closing price, and the thin wick shows the highest and lowest the price reached inside that minute. Green means it closed above where it opened, red below.' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" /* brand-token-exempt: a modal scrim dims whatever is behind it; it is not a brand surface, and bg-fg/70 would invert to white in a light theme */ onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How to trade"
        className="max-h-[85dvh] w-full min-w-0 max-w-lg overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-surface pb-[env(safe-area-inset-bottom)] sm:rounded-2xl sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4 sm:py-3">
          <div className="min-w-0 truncate text-sm font-bold text-fg">How to Trade</div>
          {/* 40px square: the close button is the only way out of the sheet on a phone, where the
              backdrop around it is a sliver. */}
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="-mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded text-xl leading-none text-muted hover:bg-border hover:text-fg">×</button>
        </div>
        <div className="space-y-4 p-3 sm:p-4">
          {sections.map((s) => (
            <div key={s.title} className="min-w-0">
              <div className="mb-1 text-xs font-bold uppercase tracking-wider text-accent">{s.title}</div>
              <p className="break-words text-sm leading-relaxed text-fg">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
