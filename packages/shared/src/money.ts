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
