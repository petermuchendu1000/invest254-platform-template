/**
 * Money utilities. All monetary values are integer CENTS of KES to avoid
 * floating-point error (KES 50.00 === 5000 cents). Every operation that could
 * produce a non-integer or negative balance is guarded.
 */
export type Cents = number;

export function isValidCents(v: number): boolean {
  return Number.isInteger(v) && Number.isFinite(v);
}

export function assertCents(v: number, label = "amount"): Cents {
  if (!isValidCents(v)) throw new RangeError(`${label} must be an integer number of cents, got ${v}`);
  return v;
}

/** Convert a KES decimal (e.g. 50.5) to integer cents (5050). Rounds half-up. */
export function kesToCents(kes: number): Cents {
  if (!Number.isFinite(kes)) throw new RangeError(`invalid KES amount: ${kes}`);
  return Math.round(kes * 100);
}

export function centsToKes(c: Cents): number {
  return assertCents(c) / 100;
}

/** Format cents as "KES 1,234.50". */
export function formatKes(c: Cents): string {
  const kes = centsToKes(c);
  // Show decimals only when there's a real fractional part, so whole shillings read as clean KES
  // ("KES 250", not "KES 250.00") — players were reading the ".00" as cents.
  const hasFraction = Math.round(kes * 100) % 100 !== 0;
  return `KES ${kes.toLocaleString("en-KE", { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/**
 * Per-brand DISPLAY currency (docs/22 branding). The money of record is ALWAYS integer KES cents
 * (wallet, ledger, bets, M-Pesa) — this is presentation only. A brand whose `sites.currency` is not
 * 'KES' renders KES amounts in its display currency at the live exchange rate `fxRateFromKes`
 * (units of the display currency per 1 KES, e.g. USD≈0.0077). Nothing here changes stored balances.
 */
export interface DisplayCurrencyOpts {
  /** ISO-4217 display currency, e.g. 'KES' | 'USD' | 'NGN'. Defaults to 'KES'. */
  currency?: string;
  /** BCP-47 locale for grouping/symbols, e.g. 'en-KE' | 'en-US'. Defaults to 'en-KE'. */
  locale?: string;
  /** Display-currency units per 1 KES (KES→currency). 1 for KES itself. */
  fxRateFromKes?: number;
}

/**
 * True when the options describe a non-KES display currency backed by a usable FX rate. A missing
 * rate is treated as NOT foreign (we never convert at an implicit 1:1 — that would misstate money),
 * so callers safely degrade to KES when the rate hasn't been resolved yet.
 */
export function isForeignDisplay(opts: DisplayCurrencyOpts | undefined): boolean {
  if (!opts) return false;
  const currency = opts.currency ?? "KES";
  const r = opts.fxRateFromKes;
  return currency !== "KES" && typeof r === "number" && Number.isFinite(r) && r > 0;
}

/**
 * Format integer KES cents for display in a brand's currency. KES (or any missing/invalid FX)
 * falls back to `formatKes` verbatim, so KES brands are byte-for-byte unchanged (no regression).
 * Non-KES currencies convert at `fxRateFromKes` and format with Intl currency style, degrading to a
 * plain "CUR 1,234.56" string if the runtime doesn't know the currency/locale.
 */
export function formatMoney(cents: Cents, opts: DisplayCurrencyOpts = {}): string {
  if (!isForeignDisplay(opts)) return formatKes(cents);
  const { currency = "KES", locale = "en-KE", fxRateFromKes = 1 } = opts;
  const amount = centsToKes(cents) * fxRateFromKes;
  // Like formatKes: show decimals only when there is a real fractional part, so round figures read
  // clean ("$15", "$100") while converted balances keep cents ("$15.46").
  const hasFraction = Math.round(amount * 100) % 100 !== 0;
  const digits = { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", ...digits }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-US", digits)}`;
  }
}

/** Convert integer KES cents to a display-currency MAJOR-unit number (for prefilling inputs). */
export function kesCentsToDisplay(cents: Cents, fxRateFromKes = 1): number {
  const rate = Number.isFinite(fxRateFromKes) && fxRateFromKes > 0 ? fxRateFromKes : 1;
  return centsToKes(cents) * rate;
}

/**
 * Convert a user-entered display-currency MAJOR-unit amount back to authoritative KES cents.
 * Used where a foreign-currency input must become a real KES money movement (M-Pesa deposit/
 * withdrawal). Rounds half-up to whole cents. `fxRateFromKes` must be a positive finite rate.
 */
export function displayToKesCents(amount: number, fxRateFromKes = 1): Cents {
  if (!Number.isFinite(amount)) throw new RangeError(`invalid display amount: ${amount}`);
  const rate = Number.isFinite(fxRateFromKes) && fxRateFromKes > 0 ? fxRateFromKes : 1;
  return Math.round((amount / rate) * 100);
}

export function addCents(a: Cents, b: Cents): Cents {
  return assertCents(a, "a") + assertCents(b, "b");
}

/** Subtract guarding against going below an optional floor (default 0). */
export function subCents(a: Cents, b: Cents, floor: Cents = 0): Cents {
  const r = assertCents(a, "a") - assertCents(b, "b");
  if (r < floor) throw new RangeError(`subtraction underflow: ${a} - ${b} < floor ${floor}`);
  return r;
}

/** Multiply cents by a real factor, rounding half-up to whole cents. */
export function mulCents(c: Cents, factor: number): Cents {
  if (!Number.isFinite(factor) || factor < 0) throw new RangeError(`invalid factor: ${factor}`);
  return Math.round(assertCents(c) * factor);
}
