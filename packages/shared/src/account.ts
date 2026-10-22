import type { Cents } from "./money.js";

/**
 * MetaTrader's account summary, computed from this game's own quantities.
 *
 * MT5's account line is built for a margin broker and this is not one: a contract is a fixed stake
 * with a fixed expiry, and nothing is borrowed. Rather than invent numbers to fill the labels, each
 * one is mapped onto a quantity that genuinely exists, so every figure on screen traces back to the
 * wallet or to an open contract:
 *
 *   Balance      the settled wallet PLUS the stake held against open contracts. MetaTrader is
 *                explicit that Balance is "money on the account, results of currently open positions
 *                not included" (docs/mt5/09-toolbox.md 470), and this engine debits the stake the
 *                moment a position opens, so the wallet alone is not it: Balance fell by the stake
 *                at open, which on a real account it never does. Adding the committed stake back is
 *                what makes the figure MetaTrader's. Nothing about the ledger changes; the money is
 *                debited exactly as before and this is the read-only view of it.
 *   Margin       stake committed to open contracts — funds reserved and unusable, which is the job
 *                margin does on a real account, and where the debited stake shows up instead
 *   Equity       Balance + the floating result, i.e. what the account is worth closed right now
 *   Free Margin  Equity - Margin
 *   Margin Level Equity / Margin * 100 — MetaTrader's own formula
 *
 * The floating result is the engine's live P/L, the same number it will settle on. Nothing here
 * feeds settlement; this is a read-only view.
 */
export interface AccountInput {
  /**
   * What the WALLET actually holds, in cents, after the engine's open-time debit.
   *
   * Named for the wallet rather than for Balance because the two differ while a position is open,
   * and conflating them is the bug this field is named after: see Balance above.
   */
  walletCents: Cents;
  /** Stake committed to contracts that are still open, in cents. */
  openStakeCents: Cents;
  /** Engine-reported floating profit/loss on those contracts, in cents (negative while losing). */
  floatingPnlCents: Cents;
}

export interface AccountSummary {
  balanceCents: Cents;
  equityCents: Cents;
  marginCents: Cents;
  freeMarginCents: Cents;
  /**
   * Equity/Margin as a percentage, or null when nothing is open.
   *
   * MetaTrader shows no margin level on a flat account rather than zero or infinity, because the
   * ratio is undefined with no margin in use — null keeps that distinction instead of printing a
   * number that would read as a margin call.
   */
  marginLevelPct: number | null;
}

export function accountSummary(input: AccountInput): AccountSummary {
  const { walletCents, openStakeCents, floatingPnlCents } = input;
  // MetaTrader's Balance excludes the results of open positions, so the committed stake is still the
  // trader's money until the contract settles: it moves to Margin, it does not leave the account.
  const balanceCents = walletCents + openStakeCents;
  // Floating P/L is reported against the STAKE, so Equity comes out as the untouched wallet plus
  // what the open position is worth right now, which is MetaTrader's "closed out at this instant".
  const equityCents = balanceCents + floatingPnlCents;
  return {
    balanceCents,
    equityCents,
    marginCents: openStakeCents,
    freeMarginCents: equityCents - openStakeCents,
    marginLevelPct: openStakeCents > 0 ? (equityCents / openStakeCents) * 100 : null,
  };
}

/**
 * Stake that one lot represents, in KES cents.
 *
 * MetaTrader states size in lots, so a volume column needs a contract size. This is a presentation
 * unit only: it converts a stake for display and never takes part in a stake, payout or outcome.
 */
export const LOT_STAKE_CENTS = 1_000_000; // 1.00 lot = KES 10,000 staked

/**
 * A stake rendered as MetaTrader's volume.
 *
 * `digits` is the SYMBOL's volume digits (`volumeDigitsOf` in ./symbols), because MetaTrader prints
 * a volume to the same number of places in every grid row that the ticket offers it in
 * (docs/mt5/09-toolbox.md 300, rows at 313-318). The two decimals that used to be hard-coded here
 * are the default only so a caller with no symbol in scope still gets the catalogue's commonest
 * step; a surface showing a real position passes the symbol's own.
 */
export const lotsOfStake = (stakeCents: Cents, digits = 2): string =>
  (stakeCents / LOT_STAKE_CENTS).toFixed(digits);

/**
 * MetaTrader's Exposure tab, computed from the contracts that are open.
 *
 * The tab answers one question: for each symbol, how much of the account is committed to it, and
 * which way. On a margin account that is a net volume and a money value; here a contract is a fixed
 * stake with a fixed expiry, so the same two quantities exist and mean the same thing:
 *
 *   volume  the stake expressed in MetaTrader's lots, signed by direction. A buy is positive and a
 *           sell negative, so two opposite contracts on one symbol net off exactly as MetaTrader's
 *           Exposure nets them.
 *   value   the stake committed, in cents. Always positive: it is money at risk, not a direction.
 *
 * `share` is each symbol's value as a fraction of the total, which is what MetaTrader draws its bar
 * from. With nothing open there are no rows, and MetaTrader shows none either.
 *
 * Nothing here can affect an outcome. It reads open contracts and reports them.
 */
export interface ExposureInput {
  symbol: string;
  direction: "buy" | "sell";
  /** Stake committed to this contract, in cents. */
  stakeCents: Cents;
}

export interface ExposureRow {
  symbol: string;
  /** Net lots, signed: positive is long, negative is short. */
  netLots: number;
  /** Money committed to the symbol, in cents. Never negative. */
  valueCents: Cents;
  /** This symbol's share of the total committed, 0 to 1. */
  share: number;
}

export function exposureRows(open: readonly ExposureInput[]): ExposureRow[] {
  const bySymbol = new Map<string, { netCents: number; valueCents: number }>();
  for (const c of open) {
    const row = bySymbol.get(c.symbol) ?? { netCents: 0, valueCents: 0 };
    row.netCents += c.direction === "buy" ? c.stakeCents : -c.stakeCents;
    row.valueCents += c.stakeCents;
    bySymbol.set(c.symbol, row);
  }
  const total = [...bySymbol.values()].reduce((sum, r) => sum + r.valueCents, 0);
  return [...bySymbol.entries()]
    .map(([symbol, r]) => ({
      symbol,
      netLots: r.netCents / LOT_STAKE_CENTS,
      valueCents: r.valueCents,
      share: total > 0 ? r.valueCents / total : 0,
    }))
    // MetaTrader lists the largest exposure first, which is the one worth looking at.
    .sort((a, b) => b.valueCents - a.valueCents || a.symbol.localeCompare(b.symbol));
}

/**
 * One amount in MetaTrader's account-strip format.
 *
 * A SPACE thousands separator and a point decimal: `3 370.75`, `1 076.68`. Measured off five
 * MetaTrader screenshots at 8x and confirmed on the Russian build, so it is build-wide rather than
 * locale-dependent — which is why this does not go through `Intl.NumberFormat`, whose separator is
 * whatever the locale says and would give `3,370.75` on en and `3.370,75` on de.
 *
 * The separator is a plain space, exactly as MetaTrader renders one. A field must therefore be laid
 * out so it cannot wrap mid-number; that is the caller's job, and the strip does it with
 * `whitespace-nowrap`.
 */
export function mtAmount(value: number, digits = 2): string {
  const fixed = Math.abs(value).toFixed(digits);
  const [whole = '0', frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** One field of MetaTrader's account summary strip. */
export interface AccountStripField {
  /** MetaTrader's own label, including its colon. */
  label: string;
  value: string;
}

/**
 * MetaTrader's account summary strip, field by field.
 *
 * The format is sourced rather than invented — see docs/mt5/09-toolbox.md section 4, which reads it
 * off the pixels of five screenshots. The rules that are easy to get wrong, and that two of this
 * platform's own labels got wrong before the sources were read:
 *
 *   - `Free Margin` and `Margin Level` capitalise their second word. They used to read "Free
 *     margin" and "Margin level" here.
 *   - The currency code appears ONCE, after the Balance value. Every other figure is bare.
 *   - Margin Level carries a space before its `%`.
 *   - The fields are separated by TWO spaces, which is the caller's layout problem rather than this
 *     function's; it returns them separately so a renderer can space them however the medium needs.
 *
 * `marginLevelPct` is null when nothing is open, because the ratio is equity over margin and margin
 * is zero. MetaTrader has no screenshot of that state, so rather than invent one the field prints a
 * dash: a number here would be a claim about an account with no position in it.
 */
export function accountStripFields(a: {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevelPct: number | null;
  /** The account's currency code, which MetaTrader prints after the balance alone. */
  currency: string;
}): AccountStripField[] {
  return [
    { label: 'Balance:', value: `${mtAmount(a.balance)} ${a.currency}` },
    { label: 'Equity:', value: mtAmount(a.equity) },
    { label: 'Margin:', value: mtAmount(a.margin) },
    { label: 'Free Margin:', value: mtAmount(a.freeMargin) },
    { label: 'Margin Level:', value: a.marginLevelPct === null ? '-' : `${mtAmount(a.marginLevelPct)} %` },
  ];
}

/**
 * The account summary block on MetaTrader's MOBILE Trade screen.
 *
 * It is not the desktop strip with different spacing — the labels, the number format and the field
 * set all differ, and the differences are sourced rather than smoothed over
 * (docs/mt5/04-mobile-app.md section 4):
 *
 *   - **No currency code anywhere.** The desktop strip writes `Balance: 3 370.75 USD`; mobile writes
 *     `Balance: 9 862.16` and leaves the currency to the account header.
 *   - **The percent sign is in the LABEL**: `Margin Level (%):` with a bare number, where the desktop
 *     strip writes `Margin Level: 1 076.68 %`.
 *   - **Android lower-cases the m in `Free margin:`**, where desktop and iOS both capitalise it.
 *     Android's casing is used here because this is a phone and the drawer is Android's pattern; the
 *     divergence is MetaQuotes' own, between its two mobile builds.
 *
 * The space thousands separator survives everywhere, which is why this shares `mtAmount` with the
 * desktop strip.
 */
export function mobileAccountRows(a: {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevelPct: number | null;
}): AccountStripField[] {
  return [
    { label: 'Balance:', value: mtAmount(a.balance) },
    { label: 'Equity:', value: mtAmount(a.equity) },
    { label: 'Margin:', value: mtAmount(a.margin) },
    { label: 'Free margin:', value: mtAmount(a.freeMargin) },
    { label: 'Margin Level (%):', value: a.marginLevelPct === null ? '-' : mtAmount(a.marginLevelPct) },
  ];
}
