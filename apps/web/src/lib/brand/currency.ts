// #10 geo-currency — client helpers for the user's display-currency choice.
//
// The choice lives in a COOKIE (not localStorage) so the server layout can read it and resolve the
// display currency + FX rate during SSR (the bearer token is localStorage-only, invisible to the
// server). Presentation only — money of record is always KES cents.

export const CURRENCY_COOKIE = 'pp-currency';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the saved display-currency choice from the cookie ('' when unset / on the server). */
export function readCurrencyCookie(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)pp-currency=([^;]*)/);
  return m ? decodeURIComponent(m[1]!).trim().toUpperCase() : '';
}

/**
 * Persist (or clear, with null/'') the display-currency choice in the cookie. `SameSite=Lax` + a
 * one-year max-age; scoped to the whole site so every route SSRs with the same choice.
 */
export function writeCurrencyCookie(currency: string | null): void {
  if (typeof document === 'undefined') return;
  const cur = (currency ?? '').trim().toUpperCase();
  document.cookie = cur
    ? `${CURRENCY_COOKIE}=${encodeURIComponent(cur)}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`
    : `${CURRENCY_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}
