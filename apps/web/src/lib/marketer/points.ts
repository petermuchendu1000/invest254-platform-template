/**
 * MARKETER-facing neutralisation primitives (Phase 1).
 *
 * The marketer app must not read as a binary-options / trading terminal on a TikTok Live: no currency
 * codes (KES / $), no "Buy/Sell/Stake/Payout/Trade" wording. Marketers play the practice/funny-money
 * bucket, never real cash, so presenting balances as neutral game POINTS is accurate, not a disguise.
 *
 * These are presentation-only helpers gated on `useIsMarketer()`. The money of record (KES cents) and
 * all stake/settlement maths are UNCHANGED — only the on-screen text a marketer sees is neutralised.
 */

/** The neutral unit shown to marketers in place of a currency code. */
export const POINTS_UNIT = 'pts';

/**
 * Format a display-currency MAJOR-units figure (e.g. 10000.00) as whole game points ("10,000") — no
 * currency word, no symbol, no decimals. Always non-negative; the caller owns any sign.
 */
export function formatPoints(majorUnits: number, locale = 'en-KE'): string {
  const n = Math.round(Math.abs(Number.isFinite(majorUnits) ? majorUnits : 0));
  return n.toLocaleString(locale);
}
