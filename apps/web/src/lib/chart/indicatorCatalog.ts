import type { Candle } from '@invest254/shared/chart';
import { bollinger } from '@invest254/shared/chart';
import {
  accelerator, adx, adxWilder, alligator, ama, atr, awesome, bearsPower, bullsPower, cci,
  closes, dema, demarker, envelopes, fractals, frama, gator, ichimoku, macd, momentum, movingAverage,
  osma, parabolicSar, rsi, rvi, stdDev, stochastic, tema, trix, vidya, williamsR,
  type Series,
} from '@invest254/shared/indicators';

/**
 * MetaTrader's Indicators menu, as data.
 *
 * The chart does not know what an indicator is. It reads this catalogue, computes the plots for
 * whichever ones are switched on, and draws them — so adding another indicator is adding an entry
 * here, never touching the rendering. That is the point: the list is long and will get longer, and
 * a 600-line chart component that grows a branch per indicator stops being reviewable.
 *
 * `pane: 'price'` draws over the candles (a moving average belongs on price). `pane: 'own'` gets a
 * sub-pane underneath, which is where MetaTrader puts anything whose units are not the price's —
 * every oscillator.
 *
 * The groups and the names are MetaTrader's own, in its own order, so the menu can be checked
 * against the Navigator tree.
 */

export type PlotKind = 'line' | 'histogram' | 'markers';
export type PlotStyle = 'solid' | 'dotted' | 'dashed';

export interface Plot {
  /** Unique within the indicator; identifies the series across re-renders. */
  key: string;
  label: string;
  kind: PlotKind;
  color: string;
  width?: 1 | 2;
  style?: PlotStyle;
  /** Index-aligned with the bars handed to `compute`; `null` where the indicator has not warmed up. */
  values: Series;
  /** `markers` only: which side of the bar, and which value the marker is placed against. */
  markerUp?: boolean;
}

export type IndicatorGroup = 'trend' | 'oscillators' | 'volumes' | 'bill-williams';

export interface IndicatorDef {
  id: string;
  /** As MetaTrader names it in the Navigator. */
  name: string;
  /** The parameters MetaTrader shows in its header, e.g. "(14)" — for the chart's legend. */
  params: string;
  group: IndicatorGroup;
  pane: 'price' | 'own';
  /** Horizontal reference lines drawn in an own-pane indicator (RSI's 30/70, CCI's ±100, zero). */
  levels?: number[];
  /**
   * Set where MetaTrader has the indicator but this instrument cannot feed it. The entry is still
   * listed, because the catalogue is meant to be checkable against MetaTrader's Navigator, but it
   * cannot be switched on and says why. Seven of MetaTrader's 38 read traded volume, and a
   * synthetic price curve has none.
   */
  unavailable?: string;
  compute: (bars: readonly Candle[]) => Plot[];
}

/** The reason the volume-fed indicators cannot run here. One sentence, used on every one of them. */
const NO_VOLUME = 'Needs traded volume, which this instrument does not report.';
const noPlots = (): Plot[] => [];

// MetaTrader's own line colours, plus a few distinct hues for the multi-line indicators.
const C = {
  blue: '#3183ff',
  sky: '#4597ff',
  green: '#41be56',
  red: '#f23645',
  amber: '#f0b90b',
  violet: '#a78bfa',
  grey: '#8fa2b8',
  teal: '#2dd4bf',
  pink: '#ec4899',
} as const;

const line = (key: string, label: string, color: string, values: Series, extra: Partial<Plot> = {}): Plot =>
  ({ key, label, kind: 'line', color, values, ...extra });

/** Pull one named field out of an array of objects into an index-aligned Series. */
const field = <T extends object, K extends keyof T>(src: Array<T | null>, k: K): Series =>
  src.map((p) => (p === null ? null : (p[k] as number | null)));

export const INDICATORS: readonly IndicatorDef[] = [
  // ───────────────────────────── trend ─────────────────────────────
  {
    id: 'ma', name: 'Moving Average', params: '(7, 25, 99)', group: 'trend', pane: 'price',
    compute: (bars) => {
      const c = closes(bars);
      return [
        line('fast', 'MA 7', C.green, movingAverage(c, 7, 'sma'), { width: 2 }),
        line('mid', 'MA 25', C.amber, movingAverage(c, 25, 'sma'), { width: 2 }),
        line('slow', 'MA 99', C.violet, movingAverage(c, 99, 'sma'), { width: 2 }),
      ];
    },
  },
  {
    id: 'bollinger', name: 'Bollinger Bands®', params: '(20, 2)', group: 'trend', pane: 'price',
    compute: (bars) => {
      const b = bollinger(closes(bars), 20, 2);
      return [
        line('upper', 'Upper', C.sky, field(b, 'upper'), { style: 'dotted' }),
        line('mid', 'Middle', C.sky, field(b, 'mid'), { style: 'dashed' }),
        line('lower', 'Lower', C.sky, field(b, 'lower'), { style: 'dotted' }),
      ];
    },
  },
  {
    id: 'envelopes', name: 'Envelopes', params: '(14, 0.1%)', group: 'trend', pane: 'price',
    compute: (bars) => {
      const e = envelopes(closes(bars), 14, 0.1);
      return [
        line('upper', 'Upper', C.teal, field(e, 'upper'), { style: 'dashed' }),
        line('lower', 'Lower', C.teal, field(e, 'lower'), { style: 'dashed' }),
      ];
    },
  },
  {
    id: 'sar', name: 'Parabolic SAR', params: '(0.02, 0.2)', group: 'trend', pane: 'price',
    // Drawn as a line because lightweight-charts has no dot series; the steps make the flips obvious.
    compute: (bars) => [line('sar', 'SAR', C.amber, parabolicSar(bars, 0.02, 0.2), { width: 1, style: 'dotted' })],
  },
  {
    id: 'ichimoku', name: 'Ichimoku Kinko Hyo', params: '(9, 26, 52)', group: 'trend', pane: 'price',
    compute: (bars) => {
      const k = ichimoku(bars);
      return [
        line('tenkan', 'Tenkan-sen', C.red, k.map((p) => p.tenkan)),
        line('kijun', 'Kijun-sen', C.blue, k.map((p) => p.kijun)),
        line('senkouA', 'Senkou Span A', C.green, k.map((p) => p.senkouA), { style: 'dashed' }),
        line('senkouB', 'Senkou Span B', C.violet, k.map((p) => p.senkouB), { style: 'dashed' }),
        line('chikou', 'Chikou Span', C.grey, k.map((p) => p.chikou), { width: 1 }),
      ];
    },
  },
  {
    id: 'ama', name: 'Adaptive Moving Average', params: '(10, 2, 30)', group: 'trend', pane: 'price',
    compute: (bars) => [line('ama', 'AMA', C.pink, ama(closes(bars), 10, 2, 30), { width: 2 })],
  },
  {
    id: 'dema', name: 'Double Exponential Moving Average', params: '(14)', group: 'trend', pane: 'price',
    compute: (bars) => [line('dema', 'DEMA', C.teal, dema(closes(bars), 14), { width: 2 })],
  },
  {
    id: 'tema', name: 'Triple Exponential Moving Average', params: '(14)', group: 'trend', pane: 'price',
    compute: (bars) => [line('tema', 'TEMA', C.sky, tema(closes(bars), 14), { width: 2 })],
  },
  {
    id: 'stddev', name: 'Standard Deviation', params: '(20)', group: 'trend', pane: 'own', levels: [0],
    compute: (bars) => [line('sd', 'StdDev', C.violet, stdDev(closes(bars), 20))],
  },
  {
    id: 'adx', name: 'Average Directional Movement Index', params: '(14)', group: 'trend', pane: 'own', levels: [20, 25],
    compute: (bars) => {
      const a = adx(bars, 14);
      return [
        line('adx', 'ADX', C.amber, field(a, 'adx'), { width: 2 }),
        line('plus', '+DI', C.green, field(a, 'plusDi')),
        line('minus', '−DI', C.red, field(a, 'minusDi')),
      ];
    },
  },
  {
    // MetaTrader ships BOTH, and they are different indicators: ADX smooths with an EMA, ADXW with
    // Wilder's SMMA. What this catalogue used to call "Average Directional Movement" was the Wilder
    // one all along.
    id: 'adxw', name: 'Average Directional Movement Index Wilder', params: '(14)', group: 'trend', pane: 'own', levels: [20, 25],
    compute: (bars) => {
      const a = adxWilder(bars, 14);
      return [
        line('adx', 'ADXW', C.amber, field(a, 'adx'), { width: 2 }),
        line('plus', '+DI', C.green, field(a, 'plusDi')),
        line('minus', '−DI', C.red, field(a, 'minusDi')),
      ];
    },
  },
  {
    id: 'frama', name: 'Fractal Adaptive Moving Average', params: '(14)', group: 'trend', pane: 'price',
    compute: (bars) => [line('frama', 'FRAMA', C.teal, frama(bars, 14), { width: 2 })],
  },
  {
    id: 'vidya', name: 'Variable Index Dynamic Average', params: '(9, 12)', group: 'trend', pane: 'price',
    compute: (bars) => [line('vidya', 'VIDyA', C.pink, vidya(closes(bars), 9, 12), { width: 2 })],
  },

  // ───────────────────────────── oscillators ─────────────────────────────
  {
    id: 'chaikin', name: 'Chaikin Oscillator', params: '(3, 10)', group: 'oscillators', pane: 'own', levels: [0],
    unavailable: NO_VOLUME, compute: noPlots,
  },
  {
    id: 'force', name: 'Force Index', params: '(13)', group: 'oscillators', pane: 'own', levels: [0],
    unavailable: NO_VOLUME, compute: noPlots,
  },
  {
    id: 'rsi', name: 'Relative Strength Index', params: '(14)', group: 'oscillators', pane: 'own', levels: [30, 50, 70],
    compute: (bars) => [line('rsi', 'RSI', C.violet, rsi(closes(bars), 14), { width: 2 })],
  },
  {
    id: 'macd', name: 'MACD', params: '(12, 26, 9)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => {
      const m = macd(closes(bars), 12, 26, 9);
      return [
        { key: 'hist', label: 'Histogram', kind: 'histogram', color: C.grey, values: field(m, 'histogram') },
        line('macd', 'MACD', C.blue, field(m, 'macd'), { width: 2 }),
        line('signal', 'Signal', C.red, field(m, 'signal')),
      ];
    },
  },
  {
    id: 'osma', name: 'Moving Average of Oscillator', params: '(12, 26, 9)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => [{ key: 'osma', label: 'OsMA', kind: 'histogram', color: C.sky, values: osma(closes(bars), 12, 26, 9) }],
  },
  {
    id: 'stochastic', name: 'Stochastic Oscillator', params: '(5, 3, 3)', group: 'oscillators', pane: 'own', levels: [20, 80],
    compute: (bars) => {
      const s = stochastic(bars, 5, 3, 3);
      return [
        line('k', '%K', C.blue, field(s, 'k'), { width: 2 }),
        line('d', '%D', C.red, field(s, 'd'), { style: 'dotted' }),
      ];
    },
  },
  {
    id: 'cci', name: 'Commodity Channel Index', params: '(14)', group: 'oscillators', pane: 'own', levels: [-100, 0, 100],
    compute: (bars) => [line('cci', 'CCI', C.amber, cci(bars, 14), { width: 2 })],
  },
  {
    id: 'atr', name: 'Average True Range', params: '(14)', group: 'oscillators', pane: 'own',
    compute: (bars) => [line('atr', 'ATR', C.teal, atr(bars, 14), { width: 2 })],
  },
  {
    id: 'momentum', name: 'Momentum', params: '(14)', group: 'oscillators', pane: 'own', levels: [100],
    compute: (bars) => [line('mom', 'Momentum', C.green, momentum(closes(bars), 14), { width: 2 })],
  },
  {
    id: 'williams', name: "Williams' Percent Range", params: '(14)', group: 'oscillators', pane: 'own', levels: [-80, -20],
    compute: (bars) => [line('wpr', '%R', C.pink, williamsR(bars, 14), { width: 2 })],
  },
  {
    id: 'demarker', name: 'DeMarker', params: '(14)', group: 'oscillators', pane: 'own', levels: [0.3, 0.7],
    compute: (bars) => [line('dem', 'DeMarker', C.sky, demarker(bars, 14), { width: 2 })],
  },
  {
    id: 'bears', name: 'Bears Power', params: '(13)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => [{ key: 'bears', label: 'Bears', kind: 'histogram', color: C.red, values: bearsPower(bars, 13) }],
  },
  {
    id: 'bulls', name: 'Bulls Power', params: '(13)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => [{ key: 'bulls', label: 'Bulls', kind: 'histogram', color: C.green, values: bullsPower(bars, 13) }],
  },
  {
    id: 'rvi', name: 'Relative Vigor Index', params: '(10)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => {
      const r = rvi(bars, 10);
      return [
        line('rvi', 'RVI', C.blue, field(r, 'rvi'), { width: 2 }),
        line('signal', 'Signal', C.red, field(r, 'signal'), { style: 'dotted' }),
      ];
    },
  },
  {
    id: 'trix', name: 'Triple Exponential Average', params: '(14)', group: 'oscillators', pane: 'own', levels: [0],
    compute: (bars) => [line('trix', 'TRIX', C.violet, trix(closes(bars), 14), { width: 2 })],
  },

  // ───────────────────────────── Bill Williams ─────────────────────────────
  {
    id: 'ao', name: 'Awesome Oscillator', params: '(5, 34)', group: 'bill-williams', pane: 'own', levels: [0],
    compute: (bars) => [{ key: 'ao', label: 'AO', kind: 'histogram', color: C.green, values: awesome(bars) }],
  },
  {
    id: 'ac', name: 'Accelerator Oscillator', params: '(5)', group: 'bill-williams', pane: 'own', levels: [0],
    compute: (bars) => [{ key: 'ac', label: 'AC', kind: 'histogram', color: C.sky, values: accelerator(bars) }],
  },
  {
    id: 'alligator', name: 'Alligator', params: '(13, 8, 5)', group: 'bill-williams', pane: 'price',
    compute: (bars) => {
      const a = alligator(bars);
      return [
        line('jaw', 'Jaw', C.blue, a.map((p) => p.jaw), { width: 2 }),
        line('teeth', 'Teeth', C.red, a.map((p) => p.teeth), { width: 2 }),
        line('lips', 'Lips', C.green, a.map((p) => p.lips), { width: 2 }),
      ];
    },
  },
  {
    id: 'gator', name: 'Gator Oscillator', params: '(13, 8, 5)', group: 'bill-williams', pane: 'own', levels: [0],
    compute: (bars) => {
      const g = gator(bars);
      return [
        { key: 'upper', label: 'Upper', kind: 'histogram', color: C.green, values: field(g, 'upper') },
        { key: 'lower', label: 'Lower', kind: 'histogram', color: C.red, values: field(g, 'lower') },
      ];
    },
  },
  {
    id: 'fractals', name: 'Fractals', params: '(5)', group: 'bill-williams', pane: 'price',
    // Markers, as MetaTrader draws them: an arrow above the bar that topped its window, below the
    // one that bottomed it. The value carried is the price the marker is pinned to.
    compute: (bars) => {
      const f = fractals(bars, 5);
      return [
        { key: 'up', label: 'Up fractal', kind: 'markers', color: C.green, markerUp: true, values: f.map((x, i) => (x.up ? bars[i]!.high : null)) },
        { key: 'down', label: 'Down fractal', kind: 'markers', color: C.red, markerUp: false, values: f.map((x, i) => (x.down ? bars[i]!.low : null)) },
      ];
    },
  },

  // ───────────────────── volume indicators (all four need traded volume) ─────────────────────
  { id: 'ad', name: 'Accumulation/Distribution', params: '', group: 'volumes', pane: 'own', unavailable: NO_VOLUME, compute: noPlots },
  { id: 'mfi', name: 'Money Flow Index', params: '(14)', group: 'volumes', pane: 'own', levels: [20, 80], unavailable: NO_VOLUME, compute: noPlots },
  { id: 'obv', name: 'On Balance Volume', params: '', group: 'volumes', pane: 'own', unavailable: NO_VOLUME, compute: noPlots },
  { id: 'volumes', name: 'Volumes', params: '', group: 'volumes', pane: 'own', unavailable: NO_VOLUME, compute: noPlots },

  // Bill Williams' sixth, which also reads volume.
  { id: 'bwmfi', name: 'Market Facilitation Index', params: '', group: 'bill-williams', pane: 'own', unavailable: NO_VOLUME, compute: noPlots },
];

export const INDICATOR_BY_ID: ReadonlyMap<string, IndicatorDef> = new Map(INDICATORS.map((i) => [i.id, i]));

/**
 * MetaTrader's Navigator group names, exactly as it writes them: "Trend Indicators",
 * "Oscillators", "Volume Indicators" and "Bill Williams' Indicators" (with the apostrophe). The
 * short forms this catalogue used before do not appear anywhere in the terminal.
 */
export const GROUP_LABELS: Record<IndicatorGroup, string> = {
  trend: 'Trend Indicators',
  oscillators: 'Oscillators',
  volumes: 'Volume Indicators',
  'bill-williams': "Bill Williams' Indicators",
};

/** The groups in MetaTrader's Navigator order, each with its indicators. */
export const INDICATOR_GROUPS: ReadonlyArray<{ group: IndicatorGroup; label: string; items: readonly IndicatorDef[] }> =
  (['trend', 'oscillators', 'volumes', 'bill-williams'] as const).map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: INDICATORS.filter((i) => i.group === group),
  }));

/**
 * MetaTrader has 38 built-in indicators. All 38 are listed here, because a catalogue you cannot
 * check against the Navigator is not a catalogue. Seven of them read traded volume:
 *
 *   Volume Indicators   Accumulation/Distribution, Money Flow Index, On Balance Volume, Volumes
 *   Oscillators         Chaikin Oscillator, Force Index
 *   Bill Williams'      Market Facilitation Index
 *
 * These candles come from a synthetic price curve that reports no volume, and the engine emits
 * ticks on a fixed timer, so even tick volume would be a constant: a flat line dressed as data.
 * They are therefore listed and disabled with the reason, rather than omitted (which hides the
 * gap) or fed an invented series (which fabricates one).
 */
export const VOLUME_GROUP_NOTE = 'Volume indicators need traded volume, which this instrument does not report.';

/** Every indicator MetaTrader ships, for the test that asserts the catalogue is complete. */
export const MT5_INDICATOR_COUNT = 38;
