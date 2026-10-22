/**
 * MetaTrader's Chart Properties (F8), as data.
 *
 * Three tabs: Common, Show, Colors. Every label below is the one MetaQuotes' own dialog screenshot
 * carries, including its trailing colon on the Colors tab and its absence everywhere else. Where its
 * prose disagrees with its dialog the dialog wins, and the disagreement is recorded in
 * docs/mt5/08-chart-properties.md rather than silently resolved.
 *
 * The single most important finding is a negative one: **MetaTrader has no logarithmic and no
 * percentage price scale.** `ENUM_CHART_PROPERTY_INTEGER` and `_DOUBLE` carry no such property, the
 * Chart Settings page lists no such control, Options > Charts has none, and an MQL5 moderator states
 * it outright: "MT5 does not have a built-in option to switch the price chart to a logarithmic scale
 * (it always uses a linear scale for price representation)." The `Linear | Log | Percent` control
 * this chart used to show was TradingView's, and it is gone rather than relabelled.
 *
 * What MetaTrader has instead is three ways of PINNING the scale, and they live here.
 */

/** The thirteen colours, keyed as MQL5's `CHART_COLOR_*` keys them. */
export type ColourField =
  | 'background' | 'foreground' | 'grid'
  | 'barUp' | 'barDown' | 'bullCandle' | 'bearCandle' | 'lineChart'
  | 'volumes' | 'bidLine' | 'askLine' | 'lastLine' | 'stopLevels';

export type Colours = Record<ColourField, string>;

/**
 * The Colors tab's fields, in MetaTrader's order, under MetaTrader's labels.
 *
 * Field 2 is a two-language error in MetaQuotes' own help: the dialog reads `Foreground:` while the
 * prose calls it "Text" in English and "Текст" in Russian. The dialog and `CHART_COLOR_FOREGROUND`
 * agree with each other, so `Foreground:` is what this carries.
 *
 * Two of them do more than their label says, and the notes are MetaQuotes' own:
 *   Volumes      also colours position opening levels.
 *   Line chart   also colours Doji candlesticks when the chart is in candlestick mode.
 */
export const COLOUR_FIELDS: ReadonlyArray<{ id: ColourField; label: string; note?: string }> = [
  { id: 'background', label: 'Background:' },
  { id: 'foreground', label: 'Foreground:' },
  { id: 'grid', label: 'Grid:' },
  { id: 'barUp', label: 'Bar up:' },
  { id: 'barDown', label: 'Bar down:' },
  { id: 'bullCandle', label: 'Bull candle:' },
  { id: 'bearCandle', label: 'Bear candle:' },
  { id: 'lineChart', label: 'Line chart:', note: 'Also colours Doji candlesticks.' },
  { id: 'volumes', label: 'Volumes:', note: 'Also colours position opening levels.' },
  { id: 'bidLine', label: 'Bid price line:' },
  { id: 'askLine', label: 'Ask price line:' },
  { id: 'lastLine', label: 'Last price line:' },
  { id: 'stopLevels', label: 'Stop levels:' },
];

export type SchemeName = 'Yellow on Black' | 'Green on Black' | 'Black on White' | 'Color on White';

/**
 * The four schemes MetaTrader's `Scheme:` dropdown offers. There is no "Custom" entry: a scheme the
 * trader has altered is saved as a TEMPLATE in MetaTrader, not as a fifth scheme.
 *
 * MetaQuotes contradicts itself on the count. Its Chart Settings page names four; its "view and
 * configure charts" page says "three color schemes of charts are available"; and the one screenshot
 * with the dropdown open is cut off by a magnifier lens after three. Four is implemented, because
 * four are named.
 *
 * **Only `Black on White` has published values.** MetaQuotes states that scheme's thirteen colours
 * and states none of the others', anywhere, in any language. The other three are therefore built
 * from what their own NAMES assert (a yellow foreground on a black background, and so on) with the
 * remaining fields taken from this terminal's palette. That derivation is ours, not MetaTrader's,
 * and it is marked as such here and in docs/mt5/08-chart-properties.md. Inventing thirteen precise
 * values and presenting them as MetaQuotes' would be worse than saying which eleven we chose.
 */
export const SCHEME_NAMES: readonly SchemeName[] = [
  'Yellow on Black', 'Green on Black', 'Black on White', 'Color on White',
];

/** This terminal's own dark palette, which is what a chart starts on. */
export const DEFAULT_COLOURS: Colours = {
  background: '#0f1720',
  foreground: '#ffffff',
  grid: '#2b3543',
  barUp: '#41be56',
  barDown: '#f23645',
  bullCandle: '#41be56',
  bearCandle: '#f23645',
  lineChart: '#3183ff',
  volumes: '#41be56',
  bidLine: '#8fa2b8',
  askLine: '#8fa2b8',
  lastLine: '#f23645',
  stopLevels: '#ff4500',
};

/** MetaQuotes' own values for `Black on White`, the one scheme it publishes. */
const BLACK_ON_WHITE: Colours = {
  background: '#ffffff',
  foreground: '#000000',
  grid: '#c0c0c0',
  barUp: '#000000',
  barDown: '#000000',
  bullCandle: '#ffffff',
  bearCandle: '#000000',
  lineChart: '#000000',
  volumes: '#008000',
  bidLine: '#c0c0c0',
  askLine: '#c0c0c0',
  lastLine: '#c0c0c0',
  stopLevels: '#ff4500',
};

export const SCHEMES: Readonly<Record<SchemeName, Colours>> = {
  // MetaQuotes' own, field for field.
  'Black on White': BLACK_ON_WHITE,
  // The three below take their background and foreground from their own names; the rest are this
  // terminal's. MetaQuotes publishes no values for them.
  'Yellow on Black': {
    ...DEFAULT_COLOURS,
    background: '#000000', foreground: '#ffff00', grid: '#363636',
    barUp: '#ffff00', barDown: '#ffff00', bullCandle: '#000000', bearCandle: '#ffff00',
    lineChart: '#ffff00', lastLine: '#ffff00',
  },
  'Green on Black': {
    ...DEFAULT_COLOURS,
    background: '#000000', foreground: '#00ff00', grid: '#363636',
    barUp: '#00ff00', barDown: '#00ff00', bullCandle: '#000000', bearCandle: '#00ff00',
    lineChart: '#00ff00', lastLine: '#00ff00',
  },
  'Color on White': {
    ...BLACK_ON_WHITE,
    barUp: '#008000', barDown: '#ff0000',
    bullCandle: '#ffffff', bearCandle: '#ff0000',
    lineChart: '#000080', volumes: '#008000',
  },
};

/**
 * The Common tab's chart types, as radio buttons, with MetaTrader's accelerators.
 *
 * MetaTrader offers exactly three. Its own prose writes "Candlestick" and "Line" while the dialog
 * writes "Candlesticks" and "Line chart"; the dialog wins.
 */
export type ChartKind = 'bars' | 'candles' | 'line';
export const CHART_KINDS: ReadonlyArray<{ id: ChartKind; label: string; accelerator: string }> = [
  { id: 'bars', label: 'Bar chart', accelerator: 'Alt+1' },
  { id: 'candles', label: 'Candlesticks', accelerator: 'Alt+2' },
  { id: 'line', label: 'Line chart', accelerator: 'Alt+3' },
];

/**
 * `CHART_SHOW_VOLUMES` is ONE property taking hide, tick or real. MetaTrader draws it as two
 * checkboxes, which makes them look independent and they are not: ticking either unticks the other.
 */
export type VolumeMode = 'hide' | 'tick' | 'real';

export interface ChartProperties {
  // ── Common ──
  kind: ChartKind;
  /** `CHART_FOREGROUND`: the price series is drawn over the indicators rather than under them. */
  chartOnForeground: boolean;
  /** `CHART_SHIFT`: the grey triangle at the top, which holds the last bar off the right edge. */
  chartShift: boolean;
  /** `CHART_SHIFT_SIZE`: 10 to 50 per cent of the window width. MetaQuotes states no default. */
  shiftSize: number;
  /** `CHART_AUTOSCROLL`. */
  autoScroll: boolean;
  /** `CHART_SCALE`, an integer 0 to 5: MetaTrader's six zoom steps, as a slider. */
  scale: number;
  /** `CHART_SCALEFIX_11`. Ticking it also ticks `scaleFix`, which is MetaTrader's own behaviour. */
  scaleFixOneToOne: boolean;
  /** `CHART_SCALEFIX`: pins the vertical scale between `fixedMaximum` and `fixedMinimum`. */
  scaleFix: boolean;
  fixedMaximum: number | null;
  fixedMinimum: number | null;
  /** `CHART_SCALE_PT_PER_BAR`. */
  scalePointsPerBar: boolean;
  /** `CHART_POINTS_PER_BAR`. */
  pointsPerBar: number;

  // ── Show ──
  showTicker: boolean;
  showOHLC: boolean;
  showQuickTradingButtons: boolean;
  showBidLine: boolean;
  showAskLine: boolean;
  showLastLine: boolean;
  showPeriodSeparators: boolean;
  showGrid: boolean;
  /** The two volume checkboxes are this one tri-state, as `CHART_SHOW_VOLUMES` is. */
  volumes: VolumeMode;
  showObjectDescriptions: boolean;
  showTradeLevels: boolean;
  showTradeHistory: boolean;

  // ── Colors ──
  scheme: SchemeName | null;
  colours: Colours;
}

export const DEFAULT_PROPERTIES: ChartProperties = {
  kind: 'candles',
  chartOnForeground: false,
  chartShift: false,
  shiftSize: 10,
  autoScroll: true,
  scale: 3,
  scaleFixOneToOne: false,
  scaleFix: false,
  fixedMaximum: null,
  fixedMinimum: null,
  scalePointsPerBar: false,
  pointsPerBar: 1,

  showTicker: true,
  showOHLC: true,
  showQuickTradingButtons: false,
  showBidLine: false,
  showAskLine: false,
  showLastLine: true,
  showPeriodSeparators: true,
  showGrid: true,
  volumes: 'hide',
  showObjectDescriptions: false,
  showTradeLevels: true,
  showTradeHistory: false,

  scheme: null,
  colours: DEFAULT_COLOURS,
};

/** `CHART_SHIFT_SIZE` is a percentage of the window width, from 10 to 50. */
export const clampShift = (pct: number): number => Math.min(50, Math.max(10, Math.round(pct)));

/** `CHART_SCALE` is an integer 0 to 5: six steps, not a continuous zoom. */
export const clampScale = (n: number): number => Math.min(5, Math.max(0, Math.round(n)));

/**
 * The Show tab's couplings, which the flat list of thirteen checkboxes hides.
 *
 * MetaQuotes states each of these, and a dialog that let them drift apart would be offering controls
 * that do not behave as MetaTrader's:
 *
 *   ticker / OHLC   coupled, and asymmetrically: unticking Show ticker unticks Show OHLC, while
 *                   ticking Show OHLC ticks Show ticker. Ticking the ticker leaves OHLC alone.
 *   tick / real     mutually exclusive, because they are one property with three values.
 *   Scale fix       disables Show tick volumes entirely: "The option is unavailable with scale fix
 *                   enabled." MetaQuotes states this for tick volumes only, not for real.
 */
export function applyShowRules(
  prev: ChartProperties,
  patch: Partial<ChartProperties>,
): ChartProperties {
  let next: ChartProperties = { ...prev, ...patch };

  if (patch.showTicker === false) next.showOHLC = false;
  if (patch.showOHLC === true) next.showTicker = true;

  // Turning scale fix on takes tick volumes with it, and one to one turns scale fix on.
  if (patch.scaleFixOneToOne === true) next.scaleFix = true;
  if (next.scaleFix && next.volumes === 'tick') next = { ...next, volumes: 'hide' };

  next.shiftSize = clampShift(next.shiftSize);
  next.scale = clampScale(next.scale);
  return next;
}

/** Is `Show tick volumes` available at all right now. */
export const tickVolumesBlocked = (p: ChartProperties): boolean => p.scaleFix;

/**
 * The Show tab, in MetaTrader's order, under its own labels.
 *
 * `unavailable` is set where MetaTrader has the control and this platform cannot honour it, the same
 * treatment the volume-fed indicators and the Expert Advisor objects get: the row stays checkable
 * against MetaTrader's dialog, and nothing pretends to work that cannot.
 *
 * Two of MetaTrader's rows are NOT here because they are not MetaTrader's: "Show chart symbol
 * watermark" and "Show period description" appear nowhere in its help, its screenshot or its chart
 * properties. Both are TradingView's vocabulary and were in our earlier notes by mistake.
 */
export const NO_VOLUME =
  'This feed carries no traded volume, so a volume reading would be invented rather than measured.';
export const NO_SPREAD =
  'This feed quotes one price, so there is no separate bid and ask to draw.';

export interface ShowRow {
  id: keyof ChartProperties | 'tickVolumes' | 'realVolumes';
  label: string;
  unavailable?: string;
}

export const SHOW_ROWS: readonly ShowRow[] = [
  { id: 'showTicker', label: 'Show ticker' },
  { id: 'showOHLC', label: 'Show OHLC' },
  { id: 'showQuickTradingButtons', label: 'Show quick trading buttons' },
  { id: 'showBidLine', label: 'Show bid price line', unavailable: NO_SPREAD },
  { id: 'showAskLine', label: 'Show ask price line', unavailable: NO_SPREAD },
  { id: 'showLastLine', label: 'Show last price line' },
  { id: 'showPeriodSeparators', label: 'Show period separators' },
  { id: 'showGrid', label: 'Show grid' },
  { id: 'tickVolumes', label: 'Show tick volumes', unavailable: NO_VOLUME },
  { id: 'realVolumes', label: 'Show real volumes', unavailable: NO_VOLUME },
  { id: 'showObjectDescriptions', label: 'Show object descriptions' },
  { id: 'showTradeLevels', label: 'Show trade levels' },
  { id: 'showTradeHistory', label: 'Show trade history' },
];

/** MetaTrader's count, pinned so the tab can be checked against its dialog. */
export const MT5_SHOW_ROW_COUNT = 13;
export const MT5_COLOUR_FIELD_COUNT = 13;
export const MT5_SCHEME_COUNT = 4;

const KEY = 'pp-chart-properties';

export function storageKey(symbol: string): string { return `${KEY}:${symbol}`; }

/**
 * Properties are per SYMBOL, as MetaTrader's are per chart window: its title is "Properties of
 * EURUSD,M1" because the settings belong to that chart and not to the terminal.
 */
/**
 * The chart's colours for a trader who has never chosen any, given the app's theme.
 *
 * MetaTrader keeps chart colours as a CHART PROPERTY, not an app theme, and this terminal does the
 * same: the F8 dialog's Colors tab and its four schemes are where a trader decides. But a trader
 * who has decided NOTHING should not be shown MetaTrader's dark chart inside a light app, which is
 * what happened the moment the light theme started working. `Black on White` is MetaTrader's own
 * light scheme and the one scheme MetaQuotes publishes pixel values for, so that is the default
 * there. A trader who has picked a scheme keeps it in both themes, because they picked it.
 */
export function defaultSchemeFor(theme: 'dark' | 'light'): SchemeName | null {
  return theme === 'light' ? 'Black on White' : null;
}

export function parseProperties(raw: string | null, theme: 'dark' | 'light' = 'dark'): ChartProperties {
  const base = theme === 'light'
    ? { ...DEFAULT_PROPERTIES, scheme: 'Black on White' as SchemeName, colours: SCHEMES['Black on White'] }
    : DEFAULT_PROPERTIES;
  if (!raw) return base;
  try {
    const got = JSON.parse(raw) as Partial<ChartProperties>;
    if (typeof got !== 'object' || got === null) return base;
    const colours = { ...base.colours, ...(got.colours ?? {}) };
    return applyShowRules(base, { ...got, colours });
  } catch { return base; }
}

export const serializeProperties = (p: ChartProperties): string => JSON.stringify(p);
