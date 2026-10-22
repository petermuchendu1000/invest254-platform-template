import { type MarketSymbol } from "./candles.js";

/**
 * The tradable symbol catalogue: forex majors, crosses and exotics, metals, crypto, indices and
 * energies.
 *
 * Three things decide what a symbol LOOKS like, and only three, because the engine's curve is
 * unitless and everything else is presentation:
 *
 *   digits    decimal places, and therefore the tick size (10^-digits). These are market
 *             conventions, not opinions: a major quotes to five places, a yen pair to three, gold
 *             to two. No licence is needed to know that, which is why this file is hand-authored
 *             rather than fetched (see docs/mt5/11-market-data-sources.md: there is no free,
 *             licence-clean source of redistributable intraday FX or metals prices, and we do not
 *             need one, because the prices here are the engine's own).
 *   anchor    the level the series starts the genesis day at. A STARTING LEVEL chosen so the chart
 *             reads like the instrument it is named after. It is not a quote, it is not claimed to
 *             be one, and nothing reads it back as market data.
 *   dayRange  how far the instrument typically travels in a day, as a fraction of its own price.
 *             Gold moves less than Bitcoin; a major moves less than either. This is what makes a
 *             crypto chart look like crypto instead of like a forex pair with a bigger number on
 *             the axis.
 *
 * `scale` is DERIVED from the last two rather than hand-picked per symbol, which is the whole point:
 * adding a symbol means stating what it is, not tuning a magic number until the chart looks right.
 * See `scaleFor`.
 *
 * `digits` is derived too, in the sense that matters: there is a stated RULE (`conventionalDigits`)
 * and a test asserts every row in the catalogue obeys it. At ninety-odd symbols, hand-picking a
 * digit count per row is ninety chances to be quietly wrong; a rule is one claim that can be
 * checked. The rule is written to reproduce the conventions that are not negotiable — a major at
 * five places, a yen pair at three, gold at two, an index at two — and it is applied, not merely
 * documented.
 *
 * None of this touches settlement. The curve is unitless and the engine scores it unitless; these
 * numbers decide only what the chart and the ticket print. See docs/mt5/12-multi-symbol-scope.md.
 */

/** MetaTrader groups symbols in a tree, and the Symbols dialog shows it rooted at the broker. */
export type SymbolGroup =
  | "Forex\\Majors" | "Forex\\Minors" | "Forex\\Exotics"
  | "Metals" | "Crypto" | "Indices" | "Energies";

export interface SymbolDef {
  symbol: string;
  /** What MetaTrader prints beside the symbol in the Specification dialog's blue header. */
  description: string;
  group: SymbolGroup;
  digits: number;
  /** Starting level for the genesis day. Not a quote. */
  anchor: number;
  /** Typical daily travel as a fraction of price: 0.008 is eight tenths of a per cent. */
  dayRange: number;
  /**
   * An explicit scale, overriding the derivation.
   *
   * Exactly one symbol uses this, and only because it predates the rule: XAUUSD shipped with a
   * hand-tuned 85, and 2650 * 0.008 / 0.25 is 84.8. Changing it would move every price the live
   * brand has ever drawn, including the execution prices stamped onto settled positions by
   * migration 0180, so the shipped number is recorded here rather than rounded back into existence.
   * A new symbol must not use this: state what the instrument IS and let the rule do the rest.
   */
  scale?: number;
}

/**
 * Price units per unit of curve value.
 *
 * The curve's value wanders over roughly a quarter of its range in a day, so a symbol that should
 * travel `dayRange` of its own price needs `anchor * dayRange / 0.25` price units per unit of value.
 *
 * That constant is back-solved from the one symbol that already existed and was tuned by eye, XAUUSD
 * at anchor 2650 and scale 85: 2650 * 0.008 / 0.25 = 84.8, within a fifth of a unit of the 85 that
 * shipped. Gold therefore keeps its shipped scale explicitly (see `SymbolDef.scale`) and every other
 * symbol is derived.
 *
 * The result is NOT rounded. Rounding to an integer looked tidier and silently destroyed every FX
 * major: EURUSD derives a scale of 0.026, which `Math.round` turns into 0, pinning the chart to a
 * flat line. A scale is a multiplier, not a price, and has no business being whole.
 */
export const CURVE_DAY_TRAVEL = 0.25;

export const scaleFor = (anchor: number, dayRange: number): number =>
  (anchor * dayRange) / CURVE_DAY_TRAVEL;

/**
 * The digit rule.
 *
 * Brokers genuinely differ on the margins of this — one house quotes USDTRY to five places and the
 * next to three — so what follows is a stated convention rather than a claim about any particular
 * broker's book. It is chosen to land exactly on the conventions nobody differs about:
 *
 *   Forex     five places, except where the quote currency is large enough that five would be
 *             meaningless precision. The yen is the famous case (USDJPY 151.500, not 151.50000),
 *             and the forint, koruna, lira, baht and rupee sit in the same band. The break is at
 *             20: below it a pip is the fourth place, above it the second, which is exactly the
 *             distinction the five/three split encodes.
 *   Metals    gold and the platinum group to two places, silver to three. Silver near 31 needs the
 *             extra place that gold near 2650 does not, so the break is magnitude again.
 *   Crypto    two places above 100, three between 1 and 100, five below. A tick of 0.01 on a coin
 *             priced at 4 would be a quarter of a per cent, which is not a tick, it is a jump.
 *   Indices   two places, universally.
 *   Energies  two for oil, three for gas, which is the same magnitude break at 10.
 *
 * Every row in `SYMBOLS` obeys this, asserted in symbols.test.ts. There are no exceptions, and a
 * new row that wants one should change the rule and say why rather than quietly diverge.
 */
export function conventionalDigits(group: SymbolGroup, anchor: number): number {
  switch (group) {
    case "Forex\\Majors":
    case "Forex\\Minors":
    case "Forex\\Exotics":
      return anchor >= 20 ? 3 : 5;
    case "Metals":
      return anchor >= 100 ? 2 : 3;
    case "Crypto":
      return anchor >= 100 ? 2 : anchor >= 1 ? 3 : 5;
    case "Indices":
      return 2;
    case "Energies":
      return anchor >= 10 ? 2 : 3;
  }
}

/**
 * The catalogue.
 *
 * Symbol naming differs between MetaTrader brokers, and there is no canonical set: US30 is DJ30
 * elsewhere, USTEC is NAS100, GER40 is DE40, XTIUSD is USOIL or WTI. The names here follow
 * MetaQuotes' own demo server where it has one, and the most common broker spelling otherwise. A
 * brand that wants a particular broker's naming can alias on the way out, but it must not RENAME a
 * row: the symbol string is the curve's seed domain, so a rename is a different instrument with a
 * different price history.
 *
 * What is deliberately absent: USDRUB and every other pair with no accessible market, leveraged and
 * inverse products, anything with an expiry, and single stocks — a stock needs corporate-action
 * handling and a dividend story that none of this has.
 */
export const SYMBOLS: readonly SymbolDef[] = [
  // ── Forex majors: the seven that carry USD on one side ──
  { symbol: "EURUSD", description: "Euro vs US Dollar", group: "Forex\\Majors", digits: 5, anchor: 1.085, dayRange: 0.006 },
  { symbol: "GBPUSD", description: "Great Britain Pound vs US Dollar", group: "Forex\\Majors", digits: 5, anchor: 1.27, dayRange: 0.007 },
  // Yen pairs quote to three places, not five. The convention, not a typo.
  { symbol: "USDJPY", description: "US Dollar vs Japanese Yen", group: "Forex\\Majors", digits: 3, anchor: 151.5, dayRange: 0.006 },
  { symbol: "USDCHF", description: "US Dollar vs Swiss Franc", group: "Forex\\Majors", digits: 5, anchor: 0.885, dayRange: 0.005 },
  { symbol: "AUDUSD", description: "Australian Dollar vs US Dollar", group: "Forex\\Majors", digits: 5, anchor: 0.655, dayRange: 0.007 },
  { symbol: "USDCAD", description: "US Dollar vs Canadian Dollar", group: "Forex\\Majors", digits: 5, anchor: 1.365, dayRange: 0.005 },
  { symbol: "NZDUSD", description: "New Zealand Dollar vs US Dollar", group: "Forex\\Majors", digits: 5, anchor: 0.605, dayRange: 0.007 },

  // ── Forex crosses: the majors against each other, with no USD leg ──
  // EURGBP and EURCHF are the two quietest pairs in the catalogue, which is the point of having
  // them: a trader who wants a slow chart has somewhere to go.
  { symbol: "EURGBP", description: "Euro vs Great Britain Pound", group: "Forex\\Minors", digits: 5, anchor: 0.835, dayRange: 0.004 },
  { symbol: "EURJPY", description: "Euro vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 164.4, dayRange: 0.007 },
  { symbol: "EURCHF", description: "Euro vs Swiss Franc", group: "Forex\\Minors", digits: 5, anchor: 0.96, dayRange: 0.004 },
  { symbol: "EURAUD", description: "Euro vs Australian Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.655, dayRange: 0.007 },
  { symbol: "EURCAD", description: "Euro vs Canadian Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.48, dayRange: 0.006 },
  { symbol: "EURNZD", description: "Euro vs New Zealand Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.79, dayRange: 0.007 },
  { symbol: "GBPJPY", description: "Great Britain Pound vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 192.5, dayRange: 0.009 },
  { symbol: "GBPCHF", description: "Great Britain Pound vs Swiss Franc", group: "Forex\\Minors", digits: 5, anchor: 1.125, dayRange: 0.006 },
  { symbol: "GBPAUD", description: "Great Britain Pound vs Australian Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.94, dayRange: 0.008 },
  { symbol: "GBPCAD", description: "Great Britain Pound vs Canadian Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.735, dayRange: 0.007 },
  { symbol: "GBPNZD", description: "Great Britain Pound vs New Zealand Dollar", group: "Forex\\Minors", digits: 5, anchor: 2.1, dayRange: 0.009 },
  { symbol: "AUDJPY", description: "Australian Dollar vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 99.2, dayRange: 0.008 },
  { symbol: "AUDCHF", description: "Australian Dollar vs Swiss Franc", group: "Forex\\Minors", digits: 5, anchor: 0.58, dayRange: 0.006 },
  { symbol: "AUDCAD", description: "Australian Dollar vs Canadian Dollar", group: "Forex\\Minors", digits: 5, anchor: 0.895, dayRange: 0.005 },
  { symbol: "AUDNZD", description: "Australian Dollar vs New Zealand Dollar", group: "Forex\\Minors", digits: 5, anchor: 1.083, dayRange: 0.004 },
  { symbol: "NZDJPY", description: "New Zealand Dollar vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 91.6, dayRange: 0.008 },
  { symbol: "NZDCHF", description: "New Zealand Dollar vs Swiss Franc", group: "Forex\\Minors", digits: 5, anchor: 0.535, dayRange: 0.006 },
  { symbol: "NZDCAD", description: "New Zealand Dollar vs Canadian Dollar", group: "Forex\\Minors", digits: 5, anchor: 0.826, dayRange: 0.006 },
  { symbol: "CADJPY", description: "Canadian Dollar vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 111.0, dayRange: 0.007 },
  { symbol: "CADCHF", description: "Canadian Dollar vs Swiss Franc", group: "Forex\\Minors", digits: 5, anchor: 0.648, dayRange: 0.005 },
  { symbol: "CHFJPY", description: "Swiss Franc vs Japanese Yen", group: "Forex\\Minors", digits: 3, anchor: 171.2, dayRange: 0.007 },

  // ── Forex exotics: a major against a Scandinavian or emerging currency ──
  // These move further than a major and a few of them barely move at all, because they are pegged
  // or managed. USDHKD and USDCNH sit at the floor of the catalogue's day range for exactly that
  // reason, and that is the honest shape of those markets rather than an oversight.
  { symbol: "USDSEK", description: "US Dollar vs Swedish Krona", group: "Forex\\Exotics", digits: 5, anchor: 10.95, dayRange: 0.007 },
  { symbol: "USDNOK", description: "US Dollar vs Norwegian Krone", group: "Forex\\Exotics", digits: 5, anchor: 11.05, dayRange: 0.008 },
  { symbol: "USDDKK", description: "US Dollar vs Danish Krone", group: "Forex\\Exotics", digits: 5, anchor: 6.92, dayRange: 0.006 },
  { symbol: "USDPLN", description: "US Dollar vs Polish Zloty", group: "Forex\\Exotics", digits: 5, anchor: 4.05, dayRange: 0.008 },
  { symbol: "USDCZK", description: "US Dollar vs Czech Koruna", group: "Forex\\Exotics", digits: 3, anchor: 23.45, dayRange: 0.007 },
  { symbol: "USDHUF", description: "US Dollar vs Hungarian Forint", group: "Forex\\Exotics", digits: 3, anchor: 385.5, dayRange: 0.009 },
  { symbol: "USDTRY", description: "US Dollar vs Turkish Lira", group: "Forex\\Exotics", digits: 3, anchor: 34.25, dayRange: 0.012 },
  { symbol: "USDZAR", description: "US Dollar vs South African Rand", group: "Forex\\Exotics", digits: 5, anchor: 18.45, dayRange: 0.012 },
  { symbol: "USDMXN", description: "US Dollar vs Mexican Peso", group: "Forex\\Exotics", digits: 5, anchor: 18.55, dayRange: 0.011 },
  { symbol: "USDSGD", description: "US Dollar vs Singapore Dollar", group: "Forex\\Exotics", digits: 5, anchor: 1.345, dayRange: 0.004 },
  // The Hong Kong dollar is pegged to a 7.75-7.85 band, so it travels less than anything else here.
  { symbol: "USDHKD", description: "US Dollar vs Hong Kong Dollar", group: "Forex\\Exotics", digits: 5, anchor: 7.785, dayRange: 0.004 },
  { symbol: "USDCNH", description: "US Dollar vs Chinese Yuan Offshore", group: "Forex\\Exotics", digits: 5, anchor: 7.245, dayRange: 0.004 },
  { symbol: "USDTHB", description: "US Dollar vs Thai Baht", group: "Forex\\Exotics", digits: 3, anchor: 34.45, dayRange: 0.006 },
  { symbol: "USDILS", description: "US Dollar vs Israeli Shekel", group: "Forex\\Exotics", digits: 5, anchor: 3.725, dayRange: 0.007 },
  { symbol: "USDINR", description: "US Dollar vs Indian Rupee", group: "Forex\\Exotics", digits: 3, anchor: 84.45, dayRange: 0.004 },
  { symbol: "EURSEK", description: "Euro vs Swedish Krona", group: "Forex\\Exotics", digits: 5, anchor: 12.05, dayRange: 0.006 },
  { symbol: "EURNOK", description: "Euro vs Norwegian Krone", group: "Forex\\Exotics", digits: 5, anchor: 11.75, dayRange: 0.007 },
  { symbol: "EURPLN", description: "Euro vs Polish Zloty", group: "Forex\\Exotics", digits: 5, anchor: 4.315, dayRange: 0.006 },
  { symbol: "EURTRY", description: "Euro vs Turkish Lira", group: "Forex\\Exotics", digits: 3, anchor: 37.15, dayRange: 0.012 },
  { symbol: "EURZAR", description: "Euro vs South African Rand", group: "Forex\\Exotics", digits: 5, anchor: 19.95, dayRange: 0.012 },
  { symbol: "EURHUF", description: "Euro vs Hungarian Forint", group: "Forex\\Exotics", digits: 3, anchor: 410.5, dayRange: 0.008 },
  { symbol: "EURCZK", description: "Euro vs Czech Koruna", group: "Forex\\Exotics", digits: 3, anchor: 25.35, dayRange: 0.006 },

  // ── Metals ──
  // XAUUSD keeps the anchor and day range that produce the scale this platform already shipped.
  { symbol: "XAUUSD", description: "Gold vs US Dollar", group: "Metals", digits: 2, anchor: 2650, dayRange: 0.008, scale: 85 },
  { symbol: "XAGUSD", description: "Silver vs US Dollar", group: "Metals", digits: 3, anchor: 31.2, dayRange: 0.018 },
  { symbol: "XPTUSD", description: "Platinum vs US Dollar", group: "Metals", digits: 2, anchor: 985, dayRange: 0.013 },
  { symbol: "XPDUSD", description: "Palladium vs US Dollar", group: "Metals", digits: 2, anchor: 1030, dayRange: 0.02 },
  { symbol: "XCUUSD", description: "Copper vs US Dollar", group: "Metals", digits: 3, anchor: 4.255, dayRange: 0.012 },
  // Gold and silver in euro. A separate instrument with its own curve, not a conversion of the
  // dollar one: converting would make the two charts move in lockstep, which real cross-quoted
  // metals do not.
  { symbol: "XAUEUR", description: "Gold vs Euro", group: "Metals", digits: 2, anchor: 2450, dayRange: 0.008 },
  { symbol: "XAGEUR", description: "Silver vs Euro", group: "Metals", digits: 3, anchor: 28.75, dayRange: 0.018 },

  // ── Crypto: the volatility is the point, so the day range is several times a major's ──
  { symbol: "BTCUSD", description: "Bitcoin vs US Dollar", group: "Crypto", digits: 2, anchor: 62_000, dayRange: 0.035 },
  { symbol: "ETHUSD", description: "Ethereum vs US Dollar", group: "Crypto", digits: 2, anchor: 2450, dayRange: 0.042 },
  { symbol: "BNBUSD", description: "Binance Coin vs US Dollar", group: "Crypto", digits: 2, anchor: 575, dayRange: 0.04 },
  { symbol: "BCHUSD", description: "Bitcoin Cash vs US Dollar", group: "Crypto", digits: 2, anchor: 340, dayRange: 0.05 },
  { symbol: "SOLUSD", description: "Solana vs US Dollar", group: "Crypto", digits: 2, anchor: 145, dayRange: 0.055 },
  { symbol: "LTCUSD", description: "Litecoin vs US Dollar", group: "Crypto", digits: 3, anchor: 72, dayRange: 0.045 },
  { symbol: "AVAXUSD", description: "Avalanche vs US Dollar", group: "Crypto", digits: 3, anchor: 27.5, dayRange: 0.055 },
  { symbol: "ETCUSD", description: "Ethereum Classic vs US Dollar", group: "Crypto", digits: 3, anchor: 18.75, dayRange: 0.05 },
  { symbol: "LINKUSD", description: "Chainlink vs US Dollar", group: "Crypto", digits: 3, anchor: 11.25, dayRange: 0.05 },
  { symbol: "UNIUSD", description: "Uniswap vs US Dollar", group: "Crypto", digits: 3, anchor: 7.45, dayRange: 0.05 },
  { symbol: "ATOMUSD", description: "Cosmos vs US Dollar", group: "Crypto", digits: 3, anchor: 4.65, dayRange: 0.05 },
  { symbol: "DOTUSD", description: "Polkadot vs US Dollar", group: "Crypto", digits: 3, anchor: 4.35, dayRange: 0.05 },
  { symbol: "XRPUSD", description: "Ripple vs US Dollar", group: "Crypto", digits: 5, anchor: 0.52, dayRange: 0.05 },
  { symbol: "ADAUSD", description: "Cardano vs US Dollar", group: "Crypto", digits: 5, anchor: 0.455, dayRange: 0.05 },
  { symbol: "TRXUSD", description: "Tron vs US Dollar", group: "Crypto", digits: 5, anchor: 0.155, dayRange: 0.045 },
  { symbol: "DOGEUSD", description: "Dogecoin vs US Dollar", group: "Crypto", digits: 5, anchor: 0.145, dayRange: 0.06 },
  { symbol: "XLMUSD", description: "Stellar vs US Dollar", group: "Crypto", digits: 5, anchor: 0.095, dayRange: 0.05 },
  // Euro-quoted crypto, same reasoning as the euro metals: its own curve, not a conversion.
  { symbol: "BTCEUR", description: "Bitcoin vs Euro", group: "Crypto", digits: 2, anchor: 57_500, dayRange: 0.035 },
  { symbol: "ETHEUR", description: "Ethereum vs Euro", group: "Crypto", digits: 2, anchor: 2270, dayRange: 0.042 },

  // ── Indices ──
  { symbol: "US30", description: "Dow Jones Industrial Average Index", group: "Indices", digits: 2, anchor: 42_000, dayRange: 0.009 },
  { symbol: "US500", description: "S&P 500 Index", group: "Indices", digits: 2, anchor: 5700, dayRange: 0.009 },
  { symbol: "USTEC", description: "US Tech 100 Index", group: "Indices", digits: 2, anchor: 19_800, dayRange: 0.012 },
  { symbol: "US2000", description: "US Small Cap 2000 Index", group: "Indices", digits: 2, anchor: 2290, dayRange: 0.013 },
  { symbol: "GER40", description: "DAX 40 Index", group: "Indices", digits: 2, anchor: 19_200, dayRange: 0.011 },
  { symbol: "UK100", description: "FTSE 100 Index", group: "Indices", digits: 2, anchor: 8250, dayRange: 0.008 },
  { symbol: "FRA40", description: "CAC 40 Index", group: "Indices", digits: 2, anchor: 7450, dayRange: 0.01 },
  { symbol: "EU50", description: "Euro Stoxx 50 Index", group: "Indices", digits: 2, anchor: 4870, dayRange: 0.01 },
  { symbol: "ESP35", description: "IBEX 35 Index", group: "Indices", digits: 2, anchor: 11_550, dayRange: 0.011 },
  { symbol: "ITA40", description: "FTSE MIB 40 Index", group: "Indices", digits: 2, anchor: 33_500, dayRange: 0.012 },
  { symbol: "SUI20", description: "Swiss Market Index", group: "Indices", digits: 2, anchor: 11_800, dayRange: 0.009 },
  { symbol: "NETH25", description: "AEX 25 Index", group: "Indices", digits: 2, anchor: 880, dayRange: 0.01 },
  { symbol: "JP225", description: "Nikkei 225 Index", group: "Indices", digits: 2, anchor: 38_500, dayRange: 0.013 },
  { symbol: "AUS200", description: "ASX 200 Index", group: "Indices", digits: 2, anchor: 8150, dayRange: 0.009 },
  { symbol: "HK50", description: "Hang Seng Index", group: "Indices", digits: 2, anchor: 20_500, dayRange: 0.014 },
  { symbol: "CHINA50", description: "FTSE China A50 Index", group: "Indices", digits: 2, anchor: 13_200, dayRange: 0.014 },
  { symbol: "IND50", description: "Nifty 50 Index", group: "Indices", digits: 2, anchor: 24_500, dayRange: 0.011 },

  // ── Energies ──
  { symbol: "XTIUSD", description: "West Texas Intermediate Crude Oil", group: "Energies", digits: 2, anchor: 70.45, dayRange: 0.022 },
  { symbol: "XBRUSD", description: "Brent Crude Oil", group: "Energies", digits: 2, anchor: 74.25, dayRange: 0.021 },
  { symbol: "XNGUSD", description: "Natural Gas", group: "Energies", digits: 3, anchor: 2.875, dayRange: 0.045 },
];

/** The catalogue as the engine's own instrument type, with `scale` derived. */
export const marketSymbolOf = (d: SymbolDef): MarketSymbol => ({
  symbol: d.symbol,
  digits: d.digits,
  anchor: d.anchor,
  scale: d.scale ?? scaleFor(d.anchor, d.dayRange),
});

const BY_SYMBOL: ReadonlyMap<string, SymbolDef> = new Map(SYMBOLS.map((d) => [d.symbol, d]));

export const symbolDef = (symbol: string): SymbolDef | undefined => BY_SYMBOL.get(symbol);

export function instrumentFor(symbol: string): MarketSymbol | undefined {
  const d = BY_SYMBOL.get(symbol);
  return d ? marketSymbolOf(d) : undefined;
}

/** The order MetaTrader's Symbols tree shows, which is the order a brand's Market Watch inherits. */
export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  "Forex\\Majors", "Forex\\Minors", "Forex\\Exotics",
  "Metals", "Crypto", "Indices", "Energies",
];

export const symbolsInGroup = (g: SymbolGroup): readonly SymbolDef[] =>
  SYMBOLS.filter((s) => s.group === g);

/** The default symbol: the one this platform shipped with, and the one that keeps the bare seed. */
export const DEFAULT_SYMBOL = "XAUUSD";

/**
 * ── Volume, per symbol ───────────────────────────────────────────────────────────────────────────
 *
 * MetaTrader carries a volume spec on EVERY symbol, not one range for the whole book: its
 * Specification dialog prints "Minimal volume", "Maximal volume" and "Volume step" per instrument,
 * and the ticket's stepper, its slider and its typed entry all obey that symbol's own three
 * numbers. A terminal that offers 0.01 to 1.00 in hundredths on gold, crypto and an index alike is
 * not showing a book, it is showing one setting.
 *
 * Brokers differ on these more than on anything else in a specification, so what follows is a
 * stated CONVENTION, in the same spirit as `conventionalDigits`: one rule that can be checked,
 * rather than ninety hand-picked rows that can each be quietly wrong. It is shaped by the two
 * things that actually drive a broker's limits:
 *
 *   LIQUIDITY sets the ceiling. A major absorbs size that an exotic does not, and a single crypto
 *   lot carries a notional an order of magnitude larger than a forex lot, so its ceiling is lower.
 *
 *   CONTRACT SIZE sets the step. An index contract is large enough that hundredths of a lot are
 *   meaningless granularity, which is why brokers quote index volume in tenths; everything else
 *   steps in hundredths, the figure MetaTrader's own screenshots show (0.01).
 *
 * ── What this does NOT do ────────────────────────────────────────────────────────────────────────
 * It does not touch settlement, and it cannot loosen the money path. A volume is only ever a way of
 * saying a stake: `stakeCents = lots * LOT_STAKE_CENTS`, and the engine validates the CENTS against
 * the brand's own minimum and maximum whatever a symbol's spec says. So these numbers narrow what
 * the UI offers; the brand's limits still bind, and the effective range is the intersection of the
 * two (see `effectiveVolume`).
 */
export interface VolumeSpec {
  /** Smallest tradable volume, in lots. */
  min: number;
  /** Largest, in lots. */
  max: number;
  /** The increment the stepper and typed entry snap to, in lots. */
  step: number;
}

export function conventionalVolume(group: SymbolGroup): VolumeSpec {
  switch (group) {
    // The seven deepest books in the catalogue: the highest ceiling, the finest step.
    case "Forex\\Majors":
      return { min: 0.01, max: 100, step: 0.01 };
    // Crosses are liquid but thinner than the majors against USD.
    case "Forex\\Minors":
      return { min: 0.01, max: 50, step: 0.01 };
    // Exotics are where a broker's ceiling drops hardest, and for the honest reason: the
    // underlying book cannot absorb the size.
    case "Forex\\Exotics":
      return { min: 0.01, max: 20, step: 0.01 };
    case "Metals":
      return { min: 0.01, max: 50, step: 0.01 };
    case "Energies":
      return { min: 0.01, max: 50, step: 0.01 };
    // Tenths, not hundredths: an index contract is large enough that a hundredth of a lot is
    // granularity nobody trades in, which is why brokers quote index volume this way.
    case "Indices":
      return { min: 0.1, max: 50, step: 0.1 };
    // One lot of crypto carries the largest notional in the book, so the ceiling is the lowest.
    case "Crypto":
      return { min: 0.01, max: 10, step: 0.01 };
  }
}

/** This symbol's own volume spec. Unknown symbols fall back to the majors' rule. */
export const volumeSpecOf = (symbol: string): VolumeSpec =>
  conventionalVolume(BY_SYMBOL.get(symbol)?.group ?? "Forex\\Majors");

/**
 * Decimals a volume prints to on this symbol — the ONE rule every surface uses.
 *
 * MetaTrader prints a volume to the symbol's own volume digits wherever it appears, in the ticket
 * and in every grid row alike (docs/mt5/09-toolbox.md 300 and the rows at 313-318). The step sets
 * it, EXCEPT where the range's minimum is not a whole number of steps: a minimum of 0.025 lots on a
 * hundredth step has to print three places, or the figure shown is not the volume actually sent.
 *
 * It lives here rather than in the order ticket because the ticket was the only surface applying the
 * off-grid rule: it showed 0.025 while the Trade grid, the History grid and the phone position row
 * showed the same position as 0.03, so the lot size appeared to change between the ticket and the
 * row it produced.
 */
export const volumeDigitsOf = (spec: VolumeSpec): number => {
  const stepDigits = Math.abs(spec.step * 100 - Math.round(spec.step * 100)) < 1e-9 && spec.step < 0.1 ? 2 : 1;
  const onGrid = Math.abs(spec.min / spec.step - Math.round(spec.min / spec.step)) < 1e-9;
  return onGrid ? stepDigits : stepDigits + 1;
};

/**
 * The symbol's spec intersected with what the brand's stake limits allow, in lots.
 *
 * The brand's money limits are authoritative: they are what the engine enforces. A symbol whose
 * conventional minimum is below the brand's minimum stake must offer the brand's, or the ticket
 * would show a volume the engine refuses; a symbol whose conventional ceiling is above the brand's
 * must offer the brand's, for the same reason.
 *
 * The STEP is the symbol's own either way, because it is granularity rather than a limit, and an
 * index that steps in tenths still steps in tenths on a brand with a small minimum.
 *
 * `brandMaxLots` of null means the brand sets no ceiling, and the symbol's own stands.
 */
export function effectiveVolume(
  spec: VolumeSpec,
  brandMinLots: number,
  brandMaxLots: number | null,
): VolumeSpec {
  const min = Math.max(spec.min, brandMinLots);
  const ceiling = brandMaxLots === null ? spec.max : Math.min(spec.max, brandMaxLots);
  // A brand whose minimum is above the symbol's ceiling leaves one tradable volume rather than an
  // inverted range the stepper could not clamp into.
  return { min, max: Math.max(min, ceiling), step: spec.step };
}
