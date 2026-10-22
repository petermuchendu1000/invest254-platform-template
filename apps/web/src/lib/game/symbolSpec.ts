/**
 * MetaTrader's Specification dialog, as data.
 *
 * The dialog is titled just `Specification` — not "Symbol Specification" — with a blue header line
 * carrying the symbol and its description, a two-column list with a type glyph per row, the label
 * left and the value right-aligned, and a single `Close` button. All of that is read off
 * MetaQuotes' own `contract_specification.png`; see docs/mt5/02-toolbox-and-panels.md section 5h.
 *
 * MetaQuotes documents around forty possible rows and states that "which fields appear depends on
 * instrument type and broker". That sentence is what makes this honest: a row that has no meaning
 * for an instrument is OMITTED by MetaTrader rather than printed empty, so omitting the swap rows
 * on a contract that cannot be held overnight is MetaTrader's own behaviour and not a shortcut.
 *
 * What this instrument genuinely has, and therefore what is shown:
 *
 *   Digits, Contract size, Spread, Margin/Profit currency, Chart mode, Trade, Execution, Filling,
 *   Expiration, Orders, Minimal/Maximal volume, Volume step, Sessions.
 *
 * What is omitted, and why each is absent rather than faked:
 *
 *   Swap type / Swap long / Swap short / Swap rates   a contract here expires in seconds and is
 *       never carried overnight, so there is no financing to charge.
 *   Exchange / Sector / CFI / Industry / Country / ISIN   this is not an exchange-listed security.
 *   Calculation       none of MetaTrader's seven modes (Forex, Futures, Collateral and so on)
 *       describes a fixed-stake contract, and picking the nearest would misstate how it settles.
 *   Stops level       the minimum distance a stop may sit from the price. The engine imposes none:
 *       it takes a stop anywhere and checks it on every tick, so there is no distance to state.
 *   Tick value        the money one tick is worth. The old reason here was that the payout followed
 *       elapsed time rather than the price; that stopped being true when the live path was rewritten
 *       to follow the PRICE (packages/shared/src/livepnl.ts). The reason that still holds is
 *       narrower: a tick is worth `stake * gain`, and `gain` is calibrated by the settlement engine
 *       PER DIRECTION and never sent to the client, so a tick is worth different money on a buy than
 *       on a sell of the same symbol and the client is told neither figure. One number here would be
 *       invented twice over.
 *   Option type / Underlying / Strike price / Accrued interest   not a derivative of a listed
 *       instrument.
 *
 * `Face value` was in that last list and should not have been. It is the contract's nominal value,
 * and here the brand sets one: a lot stakes a fixed sum, which is the whole of what a lot is. The
 * Market Watch Details tab states it (lib/game/symbolDetails); this dialog states the same quantity
 * under MetaTrader's own `Contract size`, which is the label it uses for a per-lot figure.
 */

/** MetaTrader draws a type glyph against each row: `ab` string, `01` integer, `½` fraction, `≡` enum. */
export type SpecKind = 'string' | 'integer' | 'fraction' | 'enum' | 'day';

export const SPEC_GLYPH: Record<SpecKind, string> = {
  string: 'ab',
  integer: '01',
  fraction: '½',
  enum: '≡',
  day: '\u{1F4C5}',
};

export interface SpecRow {
  label: string;
  value: string;
  kind: SpecKind;
}

export interface SpecInput {
  symbol: string;
  /** The description MetaTrader prints beside the symbol in the blue header. */
  description: string;
  digits: number;
  /** Money one lot stakes, already formatted, e.g. "KES 10,000.00". */
  contractSize: string;
  /** The account's own currency code, which is both the margin and the profit currency here. */
  currency: string;
  minVolume: number;
  maxVolume: number | null;
  volumeStep: number;
  /** The expiries the ticket offers, in the order it offers them. */
  expiries: readonly string[];
  /**
   * The spread in the symbol's own POINTS, or null on a brand that publishes none.
   *
   * MetaTrader's `Spread` row is `floating` where the spread moves and the figure where it is
   * fixed. This brand's is fixed, charged by the settlement engine and the same on every tick, so
   * the figure is what belongs here.
   */
  spreadPoints?: number | null;
  volumeDigits: number;
  /**
   * MetaTrader's `Trade` mode for this instrument. Defaults to full access.
   *
   * These are MetaTrader's own five values, and the one that matters here is `Disabled`: a broker
   * marks a symbol disabled when it quotes it but will not accept an order on it, which is exactly
   * the state of every symbol this brand does not settle. It is a real MetaTrader state rather than
   * a gap dressed up as one, and a trader who sees it on the Specification knows what it means.
   */
  tradeMode?: TradeMode;
}

export type TradeMode = 'Full access' | 'Long only' | 'Short only' | 'Close only' | 'Disabled';

export function specRows(i: SpecInput): SpecRow[] {
  const rows: SpecRow[] = [
    { label: 'Digits', value: String(i.digits), kind: 'integer' },
    { label: 'Contract size', value: `${i.contractSize} / lot`, kind: 'fraction' },
    /**
     * The brand's own fixed spread, in points.
     *
     * This row read `0` under a comment saying the instrument quotes one price so a trade opens
     * and closes on the same number. It does not: the settlement engine charges a cost on every
     * position and the terminal now quotes both sides around it. MetaTrader prints `floating`
     * where a spread moves and the figure where it is fixed; this one is fixed, so the figure is
     * what belongs here. A brand that publishes none still reads `0`, which is then true.
     */
    { label: 'Spread', value: String(i.spreadPoints ?? 0), kind: 'integer' },
    { label: 'Margin currency', value: i.currency, kind: 'string' },
    { label: 'Profit currency', value: i.currency, kind: 'string' },
    // MetaTrader's two modes are "By bid price" and "By last price". With one price, it is the last.
    { label: 'Chart mode', value: 'By last price', kind: 'enum' },
    { label: 'Trade', value: i.tradeMode ?? 'Full access', kind: 'enum' },
    { label: 'Execution', value: 'Market', kind: 'enum' },
    { label: 'Filling', value: 'Fill or Kill', kind: 'enum' },
    {
      label: 'Expiration',
      // MetaTrader's own values are Good till Canceled, Intraday, Specified time and Date. None
      // fits a contract that expires on a timer the trader picks, so the timers are listed.
      value: i.expiries.length > 0 ? i.expiries.join(', ') : 'Specified time',
      kind: 'enum',
    },
    // Market orders only: there are no pending orders on this platform, so none is claimed.
    { label: 'Orders', value: 'Market', kind: 'enum' },
    { label: 'Minimal volume', value: i.minVolume.toFixed(i.volumeDigits), kind: 'fraction' },
  ];
  if (i.maxVolume !== null) {
    rows.push({ label: 'Maximal volume', value: i.maxVolume.toFixed(i.volumeDigits), kind: 'fraction' });
  }
  rows.push({ label: 'Volume step', value: i.volumeStep.toFixed(i.volumeDigits), kind: 'fraction' });
  return rows;
}

/**
 * MetaTrader's Sessions block: a Quotes column and a Trade column, one row per weekday. This market
 * never closes, so every day carries the same span on both sides.
 */
export const SPEC_SESSION_DAYS: readonly string[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const SPEC_SESSION_SPAN = '00:00-24:00';
