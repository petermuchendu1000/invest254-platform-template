/**
 * Every country Paynicorn collects in, with its local currency and how many decimals that currency
 * takes on the wire. Transcribed from the official "Country and Currency Comparison Table"
 * (paynicorn.com/docs/appendix/currency, read 2026-10-10).
 *
 * The decimal count is NOT cosmetic: `amount` crosses as the local currency's MAJOR unit formatted to
 * exactly these decimals (KES 130 -> "130", NGN 100.50 -> "100.50"). Sending two decimals to a
 * zero-decimal currency is how you charge the wrong amount, so every country is listed explicitly
 * rather than defaulting.
 *
 * Server-side only. Nothing here reaches the browser bundle (docs/53 confidentiality).
 */
export interface PaynicornCountry {
  /** ISO-3166 alpha-2, the `countryCode` Paynicorn expects. */
  code: string;
  name: string;
  /** The country's local currency — the `currency` we send for a collection there. */
  currency: string;
  /** Decimals the local currency takes on the wire: 0, 1 or 2. */
  decimals: 0 | 1 | 2;
}

export const PAYNICORN_COUNTRIES: readonly PaynicornCountry[] = [
  // ── Africa ──
  { code: "KE", name: "Kenya", currency: "KES", decimals: 0 },
  { code: "NG", name: "Nigeria", currency: "NGN", decimals: 2 },
  { code: "UG", name: "Uganda", currency: "UGX", decimals: 2 },
  { code: "ET", name: "Ethiopia", currency: "ETB", decimals: 2 },
  { code: "GH", name: "Ghana", currency: "GHS", decimals: 2 },
  { code: "TZ", name: "Tanzania", currency: "TZS", decimals: 0 },
  { code: "ZM", name: "Zambia", currency: "ZMW", decimals: 0 },
  { code: "CM", name: "Cameroon", currency: "XAF", decimals: 0 },
  { code: "SN", name: "Senegal", currency: "XOF", decimals: 0 },
  { code: "CI", name: "Cote d'Ivoire", currency: "XOF", decimals: 0 },
  { code: "ZA", name: "South Africa", currency: "ZAR", decimals: 0 },
  // ── Middle East & North Africa ──
  { code: "EG", name: "Egypt", currency: "EGP", decimals: 1 },
  { code: "MA", name: "Morocco", currency: "MAD", decimals: 0 },
  { code: "LB", name: "Lebanon", currency: "LBP", decimals: 1 },
  { code: "AE", name: "United Arab Emirates", currency: "AED", decimals: 1 },
  { code: "KW", name: "Kuwait", currency: "KWD", decimals: 1 },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", decimals: 1 },
  { code: "QA", name: "Qatar", currency: "QAR", decimals: 1 },
  { code: "OM", name: "Oman", currency: "OMR", decimals: 1 },
  { code: "BH", name: "Bahrain", currency: "BHD", decimals: 1 },
  { code: "JO", name: "Jordan", currency: "JOD", decimals: 1 },
  { code: "IQ", name: "Iraq", currency: "IQD", decimals: 2 },
  { code: "TR", name: "Turkey", currency: "TRY", decimals: 2 },
  // ── Asia ──
  { code: "IN", name: "India", currency: "INR", decimals: 2 },
  { code: "PK", name: "Pakistan", currency: "PKR", decimals: 0 },
  { code: "BD", name: "Bangladesh", currency: "BDT", decimals: 0 },
  { code: "ID", name: "Indonesia", currency: "IDR", decimals: 0 },
  { code: "PH", name: "Philippines", currency: "PHP", decimals: 0 },
  { code: "MY", name: "Malaysia", currency: "MYR", decimals: 0 },
  { code: "TH", name: "Thailand", currency: "THB", decimals: 2 },
  { code: "CN", name: "China", currency: "CNY", decimals: 2 },
  // ── America ──
  { code: "US", name: "United States", currency: "USD", decimals: 2 },
];

const BY_CODE = new Map(PAYNICORN_COUNTRIES.map((c) => [c.code, c]));

/** The country Paynicorn knows by this ISO-2 code, or null when it collects nowhere by that name. */
export function paynicornCountry(code: string | null | undefined): PaynicornCountry | null {
  const k = String(code ?? "").trim().toUpperCase();
  return BY_CODE.get(k) ?? null;
}

/** Every ISO-2 code we may store on a brand — the check constraint in migration 0188 mirrors this. */
export const PAYNICORN_COUNTRY_CODES: readonly string[] = PAYNICORN_COUNTRIES.map((c) => c.code);

/**
 * Format a local-currency MAJOR amount for the wire, to exactly that country's decimals.
 *
 * Rounds to the currency's precision, because a converted amount almost never lands on a whole unit
 * and a zero-decimal currency cannot carry the remainder. Where the player typed the amount in the
 * collection currency itself (a KES brand collecting KES) the caller has already enforced that it is
 * a whole unit, so no rounding happens there.
 */
export function formatPaynicornAmount(major: number, decimals: 0 | 1 | 2): string {
  if (!Number.isFinite(major) || major <= 0) throw new Error("PAYNICORN_AMOUNT_INVALID");
  const out = major.toFixed(decimals);
  if (Number(out) <= 0) throw new Error("PAYNICORN_AMOUNT_INVALID");
  return out;
}
