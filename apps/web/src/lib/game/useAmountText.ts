'use client';

import { useMemo } from 'react';
import { useDisplayMoney } from '@/lib/money';

/**
 * DIGITS-UI: amounts written the way the digits broker screens show them — number first, then the
 * currency code ("19.52 USD", "475 KES"). KES cents are the money of record; foreign brands render
 * at the live FX rate with two decimals, KES brands in whole shillings.
 */
export function useAmountText() {
  const { toDisplay, isForeign, currency, locale, symbol } = useDisplayMoney();
  return useMemo(() => {
    const code = isForeign ? currency : 'KES';
    const num = (cents: number) => {
      const v = toDisplay(Math.abs(cents));
      return isForeign
        ? v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        // whole shillings, but never rounded UP (BUGLOG #105: KES 99.50 read "100" and a 100 stake was refused)
        : Number.isInteger(Math.round(v * 100) / 100) ? Math.round(v).toLocaleString(locale)
          : v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    return {
      code,
      /** Prefix for compact figures: "$" on foreign brands, "KES " on KES brands. */
      prefix: symbol === 'KES' ? 'KES ' : symbol,
      /** "19.52" (no code) */
      num,
      /** "19.52 USD" */
      text: (cents: number) => `${cents < 0 ? '-' : ''}${num(cents)} ${code}`,
      /** "+9.52 USD" / "-10.00 USD" */
      signed: (cents: number) => `${cents >= 0 ? '+' : '-'}${num(cents)} ${code}`,
    };
  }, [toDisplay, isForeign, currency, locale, symbol]);
}
