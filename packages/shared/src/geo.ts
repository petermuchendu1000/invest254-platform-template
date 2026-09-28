/**
 * Geo → display-currency resolution (#10 geo-currency).
 *
 * The money of record is ALWAYS integer KES cents — see money.ts / fx.ts. This module only helps
 * DECIDE which display currency to render for a given visitor: it maps an ISO 3166-1 alpha-2 country
 * (e.g. Cloudflare's `CF-IPCountry` header) to a curated ISO-4217 display currency, and reports which
 * currencies we allow as a display choice. Nothing here moves money or picks an FX rate; the caller
 * feeds the resolved currency to `formatMoney` / `displayToKesCents` with a live rate from fx.ts.
 *
 * The set is CURATED (not every currency fx.ts can quote): a visitor from an unmapped country simply
 * falls back to the brand's own currency, so display never lands on an obscure/untradeable unit.
 */

/** Currencies a visitor/user may be shown or may choose. KES is always allowed (the base). */
export const SUPPORTED_DISPLAY_CURRENCIES: readonly string[] = [
  "KES", "USD", "EUR", "GBP",
  "NGN", "UGX", "TZS", "GHS", "ZAR", "RWF", "ZMW", "EGP", "MAD",
  "XOF", "XAF", "INR", "AUD", "CAD", "AED",
] as const;

const SUPPORTED = new Set(SUPPORTED_DISPLAY_CURRENCIES);

/** Normalize an ISO-4217 code to upper-case, or null if it isn't a plausible 3-letter code. */
export function normalizeCurrency(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/** True when `code` is one of the currencies we allow as a display choice (case-insensitive). */
export function isSupportedDisplayCurrency(code: string | null | undefined): boolean {
  const c = normalizeCurrency(code);
  return c != null && SUPPORTED.has(c);
}

/**
 * ISO 3166-1 alpha-2 country → display currency, restricted to SUPPORTED_DISPLAY_CURRENCIES. Only
 * countries whose local currency we support are listed; everything else resolves to `undefined` and
 * the caller keeps the brand default. Eurozone members all map to EUR.
 */
const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  // East Africa (home markets)
  KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", ZM: "ZMW",
  // West Africa
  NG: "NGN", GH: "GHS",
  // XOF (West African CFA franc) union
  BJ: "XOF", BF: "XOF", CI: "XOF", GW: "XOF", ML: "XOF", NE: "XOF", SN: "XOF", TG: "XOF",
  // XAF (Central African CFA franc) union
  CM: "XAF", CF: "XAF", TD: "XAF", CG: "XAF", GQ: "XAF", GA: "XAF",
  // Rest of Africa we support
  ZA: "ZAR", EG: "EGP", MA: "MAD",
  // Major international (cards / diaspora)
  US: "USD", GB: "GBP", IN: "INR", AU: "AUD", CA: "CAD",
  AE: "AED",
  // Eurozone
  AT: "EUR", BE: "EUR", HR: "EUR", CY: "EUR", EE: "EUR", FI: "EUR", FR: "EUR", DE: "EUR",
  GR: "EUR", IE: "EUR", IT: "EUR", LV: "EUR", LT: "EUR", LU: "EUR", MT: "EUR", NL: "EUR",
  PT: "EUR", SK: "EUR", SI: "EUR", ES: "EUR",
};

/** Normalize an alpha-2 country code to upper-case, or null if not a 2-letter code. */
export function normalizeCountry(cc: string | null | undefined): string | null {
  if (typeof cc !== "string") return null;
  const c = cc.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * Resolve a display currency from an ISO alpha-2 country, or `undefined` when the country is unknown,
 * unmapped, or one of the CDN sentinels (`XX`, `T1` for Tor, etc.) — the caller then keeps the brand
 * currency. The returned code is always in SUPPORTED_DISPLAY_CURRENCIES.
 */
export function currencyForCountry(cc: string | null | undefined): string | undefined {
  const c = normalizeCountry(cc);
  if (c == null) return undefined;
  return COUNTRY_CURRENCY[c];
}

/**
 * Resolve the display currency to actually render, in priority order:
 *   1. the user's explicit, supported preference (a saved profile choice or in-session switch);
 *   2. otherwise the visitor's geo-detected currency (from the country code), if supported;
 *   3. otherwise the brand's own currency (the existing per-brand default).
 * The result is always upper-cased; an unsupported/blank preference is ignored rather than shown.
 */
export function resolveDisplayCurrency(opts: {
  userPreference?: string | null;
  countryCode?: string | null;
  brandCurrency?: string | null;
}): string {
  const pref = normalizeCurrency(opts.userPreference);
  if (pref != null && SUPPORTED.has(pref)) return pref;
  const geo = currencyForCountry(opts.countryCode);
  if (geo != null) return geo;
  const brand = normalizeCurrency(opts.brandCurrency);
  return brand ?? "KES";
}
