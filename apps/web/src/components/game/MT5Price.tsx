'use client';

import { cn } from '@/lib/cn';

/**
 * A price in MetaTrader's typography.
 *
 * MetaTrader never prints a quote as one flat number. It enlarges the digits a trader actually
 * watches — the pip figure — and, on symbols that quote a fractional pip, sets that last digit
 * small and raised. It is the single most recognisable thing about an MT5 quote, and it is what
 * makes a price readable at a glance on a phone.
 *
 * The split follows the symbol's digit count, as MetaTrader's does:
 *   3 or 5 digits  the last digit is a FRACTIONAL pip      1.13 18⁴   →  lead "1.13", pip "18", frac "4"
 *   otherwise      there is none, and the pip is the last two digits   3134. 85
 */
export function MT5Price({
  value, digits, className, tone, style,
}: {
  value: number | null | undefined;
  digits: number;
  className?: string;
  tone?: 'sell' | 'buy' | undefined;
  /**
   * For a colour that is computed rather than chosen from a fixed set, which is what Market Watch's
   * quote needs: MetaTrader colours it blue, red or grey from the tick's direction and age.
   */
  style?: React.CSSProperties | undefined;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={cn('font-mono tabular-nums', className)} style={style}>-</span>;
  }
  const text = value.toFixed(digits);
  // A fractional pip exists only on the odd-digit quotes (3 and 5), exactly as in MetaTrader.
  const hasFractionalPip = digits === 3 || digits === 5;
  const fracLen = hasFractionalPip ? 1 : 0;
  const pipLen = 2;
  const cut = text.length - fracLen - pipLen;
  const lead = text.slice(0, Math.max(0, cut));
  const pip = text.slice(Math.max(0, cut), text.length - fracLen);
  const frac = fracLen ? text.slice(-fracLen) : '';

  return (
    <span
      className={cn('font-mono tabular-nums leading-none', className)}
      style={style}
      // Screen readers and copy/paste get the plain number, not the three fragments.
      aria-label={text}
    >
      <span aria-hidden>{lead}</span>
      <span aria-hidden className={cn('text-[1.6em] font-bold', tone === 'sell' ? 'text-white' : tone === 'buy' ? 'text-white' : '')}>{pip}</span>
      {frac ? <span aria-hidden className="align-super text-[0.8em]">{frac}</span> : null}
    </span>
  );
}
