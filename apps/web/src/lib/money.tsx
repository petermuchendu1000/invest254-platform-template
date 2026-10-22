'use client';

import { useMemo } from 'react';
import { formatMoney, formatKes, isForeignDisplay, displayToKesCents, kesCentsToDisplay, type Cents } from '@invest254/shared/money';
import { mtAmount } from '@invest254/shared/account';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { POINTS_UNIT, formatPoints } from '@/lib/marketer/points';
import { cn } from '@/lib/cn';

/**
 * Brand-aware money display for the PLAYER app.
 *
 * The money of record is always integer KES cents. A brand whose `currency` is not 'KES' RENDERS
 * those amounts in its display currency at the live `fxRateFromKes` the API resolved. This hook is
 * the single place the player UI reads that config, so every price/balance/stake is consistent.
 *
 * NOTE: intentionally NOT used by the admin/finance/marketer surfaces — operators reconcile against
 * M-Pesa in KES, so those keep the raw `formatKes`/`<Money>` (KES) path.
 */
/** Compact currency symbol ("$", "₦", …) for a foreign display currency; falls back to the code. */
function currencySymbol(currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * Absolute SAFETY floors for foreign (display-currency) brands — the lowest a minimum may ever be,
 * NOT the operator's intended minimum. Each per-brand minimum is operator-driven (stake via
 * site_stake_native, deposit via min_deposit_native, withdrawal via min_withdrawal_native) and used
 * directly; these only guard the fallback path when a brand has set no native value. See `limit()`.
 */
export const USD_LIMITS = { minStake: 1, minDeposit: 1, minWithdrawal: 5 } as const;

export function useDisplayMoney() {
  const brand = useBrand();
  const { isMarketer } = useMarketerSkin();
  const currency = brand.currency || 'KES';
  const locale = brand.locale || 'en-KE';
  const fxRateFromKes = brand.fxRateFromKes ?? 1;
  // Memoised on the brand's currency config so the returned formatter has a STABLE identity across
  // renders — safe to list in useMemo/useEffect dependency arrays.
  return useMemo(() => {
    const opts = { currency, locale, fxRateFromKes };
    const foreign = isForeignDisplay(opts);
    // MARKETER: neutral game POINTS, no currency identity. The stake maths (toDisplay/toKesCents) and
    // `isForeign` stay REAL so amount entry/conversion is unchanged — only the visible text is points.
    const pts = (cents: Cents) => `${formatPoints(kesCentsToDisplay(cents, foreign ? fxRateFromKes : 1), locale)} ${POINTS_UNIT}`;
    /**
     * A figure in MetaTrader's own grid format: space thousands separator, point decimal, and NO
     * currency code.
     *
     * docs/mt5/09-toolbox.md 429 reads the code off five screenshots: it "appears only once, after
     * the Balance value", and "all other figures bare". Line 729 is stricter still for the History
     * summary strip, which carries no code "not even after Balance". Every Profit cell, every
     * History figure and the phone's position row therefore use this and not `fmt`, which is the
     * brand's wallet formatter and rightly names the currency.
     *
     * It is the same text on a marketer skin, where a bare number is also what that skin wants: the
     * point of `pts` is to withhold a currency identity, and this withholds one too.
     */
    const mt = (cents: Cents) => mtAmount(kesCentsToDisplay(cents, foreign ? fxRateFromKes : 1));
    if (isMarketer) {
      return {
        fmt: pts,
        mt,
        currency,
        locale,
        fxRateFromKes,
        isForeign: foreign,
        symbol: '',                                            // no currency symbol on a marketer screen
        both: pts,                                             // never expose the KES equivalent
        parts: (cents: Cents) => ({ display: pts(cents), kes: '', foreign: false }),
        toDisplay: (cents: Cents) => kesCentsToDisplay(cents, foreign ? fxRateFromKes : 1),
        toKesCents: (amount: number) => displayToKesCents(amount, foreign ? fxRateFromKes : 1),
        limit: (usdFloor: number, kesFloorCents: Cents): Cents => {
          if (!foreign) return kesFloorCents;
          const kesFloorUsd = Math.ceil(Math.round(kesCentsToDisplay(kesFloorCents, fxRateFromKes) * 100) / 100 - 1e-9);
          return displayToKesCents(Math.max(usdFloor, kesFloorUsd), fxRateFromKes);
        },
      } as const;
    }
    return {
      /** Format KES cents in the brand's display currency (KES fallback when no FX). */
      fmt: (cents: Cents) => formatMoney(cents, opts),
      /** The same amount bare, in MetaTrader's grid format. See `mt` above. */
      mt,
      currency,
      locale,
      fxRateFromKes,
      /** True when a non-KES currency with a usable rate is active. */
      isForeign: foreign,
      /** Compact label for inputs/chips: "$" for USD etc.; KES brands keep the familiar "KES" text. */
      symbol: foreign ? currencySymbol(currency, locale) : 'KES',
      /**
       * Display amount WITH its KES equivalent for foreign brands — "$15.46 (KES 2,000)" — so the
       * player always knows the real KES figure that M-Pesa moves. Plain KES for KES brands.
       */
      both: (cents: Cents) => (foreign ? `${formatMoney(cents, opts)} (${formatKes(cents)})` : formatKes(cents)),
      /**
       * Split for a STACKED display: the primary (display-currency) figure big, and the KES
       * equivalent to render small underneath. `foreign` is false for KES brands (no second line).
       */
      parts: (cents: Cents) => ({ display: formatMoney(cents, opts), kes: formatKes(cents), foreign }),
      /** KES cents -> display-currency major units (for prefilling inputs). */
      toDisplay: (cents: Cents) => kesCentsToDisplay(cents, foreign ? fxRateFromKes : 1),
      /** User-entered display-currency major units -> authoritative KES cents. */
      toKesCents: (amount: number) => displayToKesCents(amount, foreign ? fxRateFromKes : 1),
      /**
       * Effective minimum in KES cents for a limit that is USD-native on foreign brands.
       * Foreign: the larger of (a) the round USD floor used AS-IS, and (b) the site's KES floor rounded
       * UP to the next whole dollar. The USD floor is NEVER round-tripped through FX, so a clean $5 floor
       * stays $5 (the old code ceiled $5.000029 → $6). The KES-floor value is snapped to whole cents
       * before rounding up so FX residue can't push it a dollar higher either. KES brands: unchanged.
       */
      limit: (usdFloor: number, kesFloorCents: Cents): Cents => {
        if (!foreign) return kesFloorCents;
        const kesFloorUsd = Math.ceil(Math.round(kesCentsToDisplay(kesFloorCents, fxRateFromKes) * 100) / 100 - 1e-9);
        const wholeUsd = Math.max(usdFloor, kesFloorUsd);
        return displayToKesCents(wholeUsd, fxRateFromKes);
      },
    } as const;
  }, [currency, locale, fxRateFromKes, isMarketer]);
}

/** Inline amount in the brand's display currency (player app). Mirrors `<Money>` but currency-aware. */
export function DisplayMoney({ cents, className }: { cents: Cents; className?: string }) {
  const { fmt } = useDisplayMoney();
  return <span className={cn('font-mono tabular-nums', className)}>{fmt(cents)}</span>;
}
