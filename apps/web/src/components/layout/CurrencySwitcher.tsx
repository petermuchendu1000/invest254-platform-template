'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SUPPORTED_DISPLAY_CURRENCIES } from '@invest254/shared/geo';
import { useBrand } from '@/lib/brand/BrandProvider';
import { readCurrencyCookie, writeCurrencyCookie } from '@/lib/brand/currency';

/**
 * #10 geo-currency: lets the visitor choose the DISPLAY currency (presentation only — money of record
 * stays KES cents). "Auto" clears the choice and falls back to geo-detection, then the brand currency.
 *
 * The choice is stored in the `pp-currency` cookie, which the server layout reads to resolve the
 * currency + live FX rate during SSR — so `router.refresh()` is all that's needed to re-render every
 * amount (and the deposit forms' local→KES conversion) in the new currency. The cookie is per-device
 * and lasts a year; it is deliberately NOT persisted to the account, so no schema change is required.
 */
export function CurrencySwitcher({ className = '' }: { className?: string }) {
  const router = useRouter();
  const brand = useBrand();
  // The explicit choice (cookie). '' = Auto. Read after mount to avoid a hydration mismatch.
  const [choice, setChoice] = useState('');
  useEffect(() => { setChoice(readCurrencyCookie()); }, []);

  function onChange(next: string) {
    setChoice(next);
    writeCurrencyCookie(next || null);
    router.refresh();
  }

  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-muted ${className}`}>
      <span className="sr-only">Display currency</span>
      <select
        value={choice}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Display currency"
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
      >
        <option value="">Auto ({brand.currency || 'KES'})</option>
        {SUPPORTED_DISPLAY_CURRENCIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </label>
  );
}
