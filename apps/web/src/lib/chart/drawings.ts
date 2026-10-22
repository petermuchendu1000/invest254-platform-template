/**
 * MetaTrader's analytical OBJECTS — the drawing tools — as data and geometry.
 *
 * The chart's left rail used to be decoration: eight icons that drew nothing. This is what they
 * draw. `lightweight-charts` has no drawing primitives at all (it renders series and nothing else),
 * so every object is stored here in CHART space — a time and a price per anchor — and projected to
 * pixels at paint time. That is the whole reason objects stay pinned to the bars they were drawn
 * against when the chart is panned or zoomed; anchoring them in pixels would slide them off the
 * price the moment the view moved.
 *
 * Everything in this file is pure, so the arithmetic that actually matters — where a Fibonacci level
 * sits, what a pitchfork's parallels are, what a measurement reports — is tested without a browser.
 */

import { objectToken, objectTypeName } from './objects';

/** One anchor of a drawing, in the chart's own coordinates. */
export interface Anchor {
  /** Epoch SECONDS, matching lightweight-charts' UTCTimestamp. */
  time: number;
  price: number;
}

/**
 * Every object a trader can draw, named after MetaTrader's Insert > Objects tree (see objects.ts
 * for the tree itself and the seven Expert Advisor objects that cannot exist here).
 *
 * `measure` is ours rather than MetaTrader's: its ruler is a crosshair DRAG, not an Insert object,
 * and this keeps the same capability as a tool because a web chart has no middle mouse button.
 */
export type DrawingKind =
  // Lines
  | 'horizontal' | 'vertical' | 'trend' | 'trendAngle' | 'cycleLines' | 'arrowedLine'
  // Channels
  | 'channelEquidistant' | 'channelStdDev' | 'channelRegression' | 'pitchfork'
  // Gann
  | 'gannLine' | 'gannFan' | 'gannGrid'
  // Fibonacci
  | 'fib' | 'fibTimeZones' | 'fibFan' | 'fibArcs' | 'fibChannel' | 'fibExpansion'
  // Elliott
  | 'elliottImpulse' | 'elliottCorrection'
  // Shapes
  | 'rectangle' | 'triangle' | 'ellipse'
  // Arrows
  | 'thumbsUp' | 'thumbsDown' | 'arrowUp' | 'arrowDown' | 'stopSign' | 'checkSign'
  | 'leftPriceLabel' | 'rightPriceLabel' | 'buySign' | 'sellSign' | 'arrow'
  // Graphical
  | 'text' | 'textLabel'
  // ours: the ruler
  | 'measure';

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /**
   * MetaTrader's object NAME: the unique handle every object carries, which the Objects List prints
   * in its Name column and which `ObjectCreate` requires. MetaTrader names a hand-drawn object
   * after its type plus a number, and lets the trader rename it in Object Properties, so this is a
   * stored string rather than something derived at paint time. Absent on objects drawn before the
   * Objects List existed, which fall back to their type name.
   */
  name?: string;
  /** 1 anchor for horizontal/text, 2 for trend/fib/measure, 3 for a pitchfork. */
  points: Anchor[];
  /**
   * MetaTrader's `OBJPROP_TEXT` — the object's description. On a Text or Text Label it is what the
   * chart draws; on every other object it is the text the Objects List shows in its Description
   * column and the chart shows when "Show object descriptions" is on.
   */
  label?: string;
  color: string;
  /**
   * `OBJPROP_STYLE` — MetaTrader's five line styles. Absent means solid, which is every object's
   * default, so an object drawn before Object Properties existed reads correctly.
   */
  style?: LineStyle;
  /** `OBJPROP_WIDTH`, 1 to 5 as MetaTrader allows. Absent means 1. */
  width?: number;
  /** `OBJPROP_BACK` — "Draw object as background": the candles are drawn over the object. */
  back?: boolean;
  /**
   * `OBJPROP_SELECTABLE`. MetaTrader's dialog offers the inverse, "Disable selection"; this stores
   * the property. Absent means selectable.
   */
  selectable?: boolean;
  /**
   * `OBJPROP_TIMEFRAMES` — the periods the object is shown on. Absent means every period, which is
   * what MetaTrader's "Show object in all timeframes" means.
   */
  timeframes?: string[];
  /** `OBJPROP_RAY_LEFT` / `OBJPROP_RAY_RIGHT`: does the line continue past its anchors. */
  rayLeft?: boolean;
  rayRight?: boolean;
  /** `OBJPROP_LEVEL*` — the levels grid, for the objects that have one. */
  levels?: ObjectLevel[];
  /**
   * `Fill` on the Parameters tab of a closed shape: "enable/disable color filling inside the
   * shape". MetaTrader fills a shape from "Draw object as background" too, so `back` implies it.
   */
  fill?: boolean;
  /**
   * The Gann objects' `Pips per bar:` — "scale for plotting the Gann Fan in a chart. Ratio of pips
   * number to one bar". MetaTrader shows it as 4.000000 on a Fan and 1.000000 on a Line.
   */
  pipsPerBar?: number;
  /** The Gann Fan's `Downtrend`: "the Gann Fan will be inclined downwards". */
  downtrend?: boolean;
  /** The Gann Line's `Gann angle:`, in degrees. MetaTrader shows 7.76 on its own screenshot. */
  gannAngle?: number;
}

/** MetaTrader's `ENUM_LINE_STYLE`, under the names its Style dropdown prints. */
export type LineStyle = 'solid' | 'dash' | 'dot' | 'dashDot' | 'dashDotDot';

export const LINE_STYLES: ReadonlyArray<{ id: LineStyle; label: string; dash: string | undefined }> = [
  { id: 'solid', label: 'Solid', dash: undefined },
  { id: 'dash', label: 'Dash', dash: '8 4' },
  { id: 'dot', label: 'Dot', dash: '1 3' },
  { id: 'dashDot', label: 'Dash-dot', dash: '8 3 1 3' },
  { id: 'dashDotDot', label: 'Dash-dot-dot', dash: '8 3 1 3 1 3' },
];

export const dashOf = (style: LineStyle | undefined): string | undefined =>
  LINE_STYLES.find((s) => s.id === (style ?? 'solid'))?.dash;

/** One row of the Object Properties Levels grid: `OBJPROP_LEVELVALUE` and `OBJPROP_LEVELTEXT`. */
export interface ObjectLevel {
  /** MetaTrader stores the ratio; the grid shows it as a percentage. */
  value: number;
  text: string;
  color?: string;
}

/**
 * How many anchors each object needs before it is complete. Taken from MetaTrader's own control
 * points: a trendline has two, a pitchfork three, an impulse wave six (0 through 5).
 */
export const ANCHORS_NEEDED: Record<DrawingKind, number> = {
  // Lines
  horizontal: 1, vertical: 1, trend: 2, trendAngle: 2, cycleLines: 2, arrowedLine: 2,
  // Channels
  channelEquidistant: 3, channelStdDev: 2, channelRegression: 2, pitchfork: 3,
  // Gann
  gannLine: 2, gannFan: 2, gannGrid: 2,
  // Fibonacci
  fib: 2, fibTimeZones: 2, fibFan: 2, fibArcs: 2, fibChannel: 3, fibExpansion: 3,
  // Elliott
  elliottImpulse: 6, elliottCorrection: 4,
  // Shapes
  rectangle: 2, triangle: 3, ellipse: 2,
  // Arrows: all single-anchor glyphs
  thumbsUp: 1, thumbsDown: 1, arrowUp: 1, arrowDown: 1, stopSign: 1, checkSign: 1,
  leftPriceLabel: 1, rightPriceLabel: 1, buySign: 1, sellSign: 1, arrow: 1,
  // Graphical
  text: 1, textLabel: 1,
  // ours
  measure: 2,
};

/** The tools on the rail. `cursor` and `crosshair` draw nothing; `trash` is an action. */
export type ToolId = 'cursor' | 'crosshair' | DrawingKind | 'trash' | 'objects';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** SVG path data on a 24×24 viewBox. */
  icon: string;
}

/**
 * The rail, which is MetaTrader's Line Studies toolbar: Cursor and Crosshair, then the objects
 * themselves behind a grouped button, exactly as MetaTrader groups them into dropdowns rather than
 * laying 44 icons in a row. `objects` is not a tool, it opens the Insert > Objects tree.
 */
export const TOOLS: readonly ToolDef[] = [
  { id: 'cursor', label: 'Cursor', icon: 'M5 3l6 14 2-6 6-2z' },
  { id: 'crosshair', label: 'Crosshair', icon: 'M12 3v18M3 12h18' },
  { id: 'measure', label: 'Measure', icon: 'M7 4h10l-5 16z' },
];

/**
 * Fibonacci retracement ratios, as MetaTrader draws them.
 *
 * 0 is the second anchor and 1 the first, so dragging from a low to a high puts 0% at the high —
 * which is the direction a retracement is read in.
 */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 1, 1.618, 2.618, 4.236];

/** Fibonacci Fan and Arcs use three ratios, not the retracement's nine. */
export const FIB_FAN_LEVELS: readonly number[] = [0.382, 0.5, 0.618];
/** Fibonacci Expansion's documented levels. */
export const FIB_EXPANSION_LEVELS: readonly number[] = [0.618, 1, 1.618];
/** Fibonacci Channel's documented levels. */
export const FIB_CHANNEL_LEVELS: readonly number[] = [0.618, 1, 1.618, 2.618, 4.236];
/** Fibonacci Time Zones step by the Fibonacci sequence itself, in bars from the first anchor. */
export const FIB_TIME_ZONES: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export interface FibLine { ratio: number; price: number; label: string }

/**
 * The price each Fibonacci level sits at, between two anchors.
 *
 * `levels` overrides the ratios with the ones the trader set on the Levels tab, and carries their
 * descriptions with them — MetaTrader labels a level with its Description, not with its ratio, and
 * the description defaults to the percentage.
 */
export function fibLines(a: Anchor, b: Anchor, levels?: readonly ObjectLevel[]): FibLine[] {
  // The defaults are the Levels tab's defaults, so the chart and the dialog cannot disagree:
  // MetaTrader describes them "0.0", "23.6", "38.2" and so on, with no percent sign.
  const rows: readonly ObjectLevel[] = levels && levels.length > 0 ? levels : defaultLevelsOf('fib');
  return rows.map(({ value: ratio, text }) => {
    // ratio 0 lands on `b` (where the drag ended) and 1 on `a`, so a drag low→high reads top-down.
    const price = b.price + (a.price - b.price) * ratio;
    return { ratio, price, label: text };
  });
}

/**
 * A level's label, with MetaTrader's `%$` placeholder resolved to the level's own price.
 *
 * MetaQuotes documents it for exactly two objects, the Fibonacci Retracement and the Fibonacci
 * Expansion: "To do it, specify the (%$) symbols in the 'Description' field." It writes the token
 * inside parentheses in both places and never shows a screenshot of one in use, so whether the
 * parentheses belong to the token is unverified; both forms are accepted here.
 */
export function levelLabel(text: string, price: number, digits: number): string {
  return text.replace(/\(%\$\)|%\$/g, price.toFixed(digits));
}

export interface Line { from: Anchor; to: Anchor }

/**
 * Andrews pitchfork from three anchors: the handle runs from the first pivot to the midpoint of the
 * other two, and the two tines run parallel to it from each of those.
 *
 * Each line is returned with its far end extended well beyond the third anchor, because a pitchfork
 * is used for where price is GOING; a fork that stops at the last pivot says nothing about that.
 */
export function pitchforkLines(a: Anchor, b: Anchor, c: Anchor, extend = 3): { median: Line; upper: Line; lower: Line } {
  const mid: Anchor = { time: (b.time + c.time) / 2, price: (b.price + c.price) / 2 };
  const dt = mid.time - a.time;
  const dp = mid.price - a.price;
  const far = (from: Anchor): Anchor => ({ time: from.time + dt * extend, price: from.price + dp * extend });
  return {
    median: { from: a, to: far(a) },
    upper: { from: b, to: far(b) },
    lower: { from: c, to: far(c) },
  };
}

export interface Measurement {
  /** Price change from the first anchor to the second. */
  delta: number;
  /** …as a percentage of the first anchor's price. */
  percent: number;
  /** Seconds between the anchors (always positive). */
  seconds: number;
  /** Bars between the anchors at the given timeframe, when one is known. */
  bars: number | null;
  up: boolean;
}

/** What MetaTrader's measure tool reports: how far, how much, how long. */
export function measure(a: Anchor, b: Anchor, barSeconds?: number): Measurement {
  const delta = b.price - a.price;
  const seconds = Math.abs(b.time - a.time);
  return {
    delta,
    percent: a.price === 0 ? 0 : (delta / a.price) * 100,
    seconds,
    bars: barSeconds && barSeconds > 0 ? Math.round(seconds / barSeconds) : null,
    up: delta >= 0,
  };
}

/** A duration as MetaTrader writes it on the measure label. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
  return `${(seconds / 86_400).toFixed(seconds % 86_400 === 0 ? 0 : 1)}d`;
}

export interface Point { x: number; y: number }

// ───────────────────────────── persistence ─────────────────────────────

const KEY = 'pp-chart-drawings';
const MAX_PER_SYMBOL = 200;

/** Drawings survive a reload, as MetaTrader's objects survive closing the terminal. Per symbol. */
export function storageKey(symbol: string): string { return `${KEY}:${symbol}`; }

/** Parse stored drawings, discarding anything malformed rather than throwing on a bad value. */
export function parseDrawings(raw: string | null): Drawing[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDrawing).slice(0, MAX_PER_SYMBOL);
  } catch {
    return [];
  }
}

function isDrawing(v: unknown): v is Drawing {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Partial<Drawing>;
  if (typeof d.id !== 'string' || typeof d.color !== 'string') return false;
  if (typeof d.kind !== 'string' || !(d.kind in ANCHORS_NEEDED)) return false;
  if (!Array.isArray(d.points) || d.points.length === 0) return false;
  return d.points.every((p) => typeof p?.time === 'number' && typeof p?.price === 'number'
    && Number.isFinite(p.time) && Number.isFinite(p.price));
}

/** Serialise for storage, capped so a long session cannot grow the key without bound. */
export function serializeDrawings(drawings: readonly Drawing[]): string {
  return JSON.stringify(drawings.slice(-MAX_PER_SYMBOL));
}

// ─────────────────────────────── MetaTrader's object geometry ───────────────────────────────
//
// Everything below is pure: anchors in, chart-space geometry out. The renderer projects the result
// into pixels, so the maths can be tested without a chart, a DOM or a browser.

/** A straight line through two anchors, in chart space. */
export interface ChartLine { a: Anchor; b: Anchor }

/**
 * Extend a segment past its second anchor, which is what MetaTrader's "ray" objects do. The factor
 * multiplies the original run, so a short drag still produces a usable ray.
 */
export function extendRay(a: Anchor, b: Anchor, times = 4): ChartLine {
  return {
    a,
    b: { time: a.time + (b.time - a.time) * times, price: a.price + (b.price - a.price) * times },
  };
}

/**
 * Equidistant Channel: a trendline through two anchors, and its parallel through a third.
 * MetaTrader offsets the parallel by the third anchor's distance from the base line, measured in
 * price at that anchor's time, so the two lines stay parallel in chart space rather than on screen.
 */
export function equidistantChannel(a: Anchor, b: Anchor, c: Anchor): { base: ChartLine; parallel: ChartLine } {
  const span = b.time - a.time;
  const slope = span === 0 ? 0 : (b.price - a.price) / span;
  const onBaseAtC = a.price + slope * (c.time - a.time);
  const offset = c.price - onBaseAtC;
  return {
    base: { a, b },
    parallel: { a: { time: a.time, price: a.price + offset }, b: { time: b.time, price: b.price + offset } },
  };
}

/**
 * Gann Fan: rays from one anchor at the Gann ratios. The 1x1 ray runs through the second anchor,
 * and every other ray divides or multiplies its slope by the ratio, which is what makes the fan
 * a statement about price moving one unit per unit of time.
 */
export const GANN_RATIOS: readonly number[] = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];

/**
 * `unitPerSecond` is MetaTrader's `Pips per bar:` once it has been divided by the bar length: the
 * Gann objects' scale is a declared price-per-bar, not whatever the trader happened to drag, and
 * MetaTrader's second anchor on a Gann Fan is a DATE with no price for exactly that reason. Left
 * undefined, the 1x1 slope comes from the drag, which is what the object was drawn as.
 */
export function gannFan(a: Anchor, b: Anchor, times = 4, unitPerSecond?: number): Array<{ ratio: number; line: ChartLine; label: string }> {
  const span = b.time - a.time;
  const unit = unitPerSecond ?? (span === 0 ? 0 : (b.price - a.price) / span); // the 1x1 slope
  return GANN_RATIOS.map((ratio) => {
    const slope = unit * ratio;
    const t = a.time + span * times;
    return {
      ratio,
      label: ratio >= 1 ? `${ratio}x1` : `1x${Math.round(1 / ratio)}`,
      line: { a, b: { time: t, price: a.price + slope * (t - a.time) } },
    };
  });
}

/**
 * Gann Grid: a lattice at the 1x1 slope. The spacing is the drag itself, so the grid is scaled by
 * how far the trader dragged, exactly as MetaTrader's is.
 */
export function gannGrid(a: Anchor, b: Anchor, cells = 8, unitPerSecond?: number): { verticals: number[]; horizontals: number[] } {
  const dt = b.time - a.time;
  const dp = unitPerSecond === undefined ? b.price - a.price : unitPerSecond * dt;
  const verticals: number[] = [];
  const horizontals: number[] = [];
  for (let i = -cells; i <= cells; i++) {
    verticals.push(a.time + dt * i);
    horizontals.push(a.price + dp * i);
  }
  return { verticals, horizontals };
}

/**
 * Fibonacci Fan: rays from the first anchor through the retracement levels of the second.
 * The ratio is applied to the PRICE span, which is what makes the fan a set of support lines
 * rather than a set of equally-spaced rays.
 */
export function fibFan(a: Anchor, b: Anchor, times = 3): Array<{ ratio: number; line: ChartLine }> {
  const dt = b.time - a.time;
  const dp = b.price - a.price;
  return FIB_FAN_LEVELS.map((ratio) => {
    const t = a.time + dt * times;
    const priceAtB = a.price + dp * ratio;
    const slope = dt === 0 ? 0 : (priceAtB - a.price) / dt;
    return { ratio, line: { a, b: { time: t, price: a.price + slope * (t - a.time) } } };
  });
}

/** Fibonacci Time Zones: vertical lines at Fibonacci multiples of the drag's own width. */
export function fibTimeZones(a: Anchor, b: Anchor): Array<{ step: number; time: number }> {
  const unit = b.time - a.time;
  return FIB_TIME_ZONES.map((step) => ({ step, time: a.time + unit * step }));
}

/** Fibonacci Arcs: radii at the fan ratios, measured from the first anchor. */
export function fibArcs(a: Anchor, b: Anchor): Array<{ ratio: number; dTime: number; dPrice: number }> {
  return FIB_FAN_LEVELS.map((ratio) => ({
    ratio,
    dTime: (b.time - a.time) * ratio,
    dPrice: (b.price - a.price) * ratio,
  }));
}

/**
 * Fibonacci Expansion: three anchors. The first two give the impulse, the third the retracement,
 * and the levels project the impulse forward from there.
 */
export function fibExpansion(a: Anchor, b: Anchor, c: Anchor): Array<{ ratio: number; price: number; label: string }> {
  const impulse = b.price - a.price;
  return FIB_EXPANSION_LEVELS.map((ratio) => ({
    ratio,
    price: c.price + impulse * ratio,
    label: `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`,
  }));
}

/**
 * Fibonacci Channel: a base line through two anchors, with parallels at the Fibonacci multiples of
 * the channel width set by the third.
 */
export function fibChannel(a: Anchor, b: Anchor, c: Anchor): Array<{ ratio: number; line: ChartLine }> {
  const { base, parallel } = equidistantChannel(a, b, c);
  const width = parallel.a.price - base.a.price;
  return [{ ratio: 0, line: base }, ...FIB_CHANNEL_LEVELS.map((ratio) => ({
    ratio,
    line: {
      a: { time: base.a.time, price: base.a.price + width * ratio },
      b: { time: base.b.time, price: base.b.price + width * ratio },
    },
  }))];
}

/**
 * Least-squares fit through the bars between two anchors, which is what the Regression Channel and
 * the Standard Deviation Channel are both built on. `bars` carries the closes in the span; the
 * caller supplies them because this module never reads the chart.
 */
export function linearRegression(points: ReadonlyArray<{ x: number; y: number }>): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0]!.y : 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

/** The root-mean-square distance of the points from the fitted line, for the deviation channel. */
export function regressionDeviation(
  points: ReadonlyArray<{ x: number; y: number }>,
  fit: { slope: number; intercept: number },
): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const p of points) { const d = p.y - (fit.intercept + fit.slope * p.x); sum += d * d; }
  return Math.sqrt(sum / points.length);
}

/** Elliott wave labels, in MetaTrader's own notation. */
export const ELLIOTT_IMPULSE_LABELS: readonly string[] = ['0', '1', '2', '3', '4', '5'];
export const ELLIOTT_CORRECTION_LABELS: readonly string[] = ['0', 'A', 'B', 'C'];

/**
 * A name for a newly drawn object, in MetaTrader's exact shape:
 *
 *     <TIMEFRAME> <Object type> <ID>          M1 Trendline 31757
 *
 * All three parts are MetaTrader's, read off MetaQuotes' own screenshots (see
 * docs/mt5/07-objects-list-and-properties.md for the eight observed examples):
 *
 *   TIMEFRAME  the period the object was CREATED on, not the one being viewed. "M1", "H1".
 *   type       MetaTrader's token for the type, which is not always the menu label: a Fibonacci
 *              Retracement is "Fibo", a Standard Deviation Channel is "StdDev Channel", and
 *              Andrews' Pitchfork drops its apostrophe.
 *   ID         a 4 or 5 digit integer. What generates MetaTrader's is undocumented and is NOT a
 *              counter from one, so this draws one at random in the observed range and retries on
 *              a collision. MQL5's only constraint is that the name is unique within the chart.
 */
export function nextObjectName(kind: DrawingKind, existing: readonly Drawing[], timeframe: string): string {
  const token = objectToken(kind);
  const taken = new Set(existing.map((d) => d.name).filter((n): n is string => typeof n === 'string'));
  for (let tries = 0; tries < 200; tries += 1) {
    // 1000 to 65535: four and five digits, which is the range every observed MetaTrader id sits in.
    const id = 1000 + Math.floor(Math.random() * 64_536);
    const candidate = `${timeframe} ${token} ${id}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${timeframe} ${token} ${Date.now() % 100_000}`;
}

/** The object's name, falling back to its type for objects drawn before names were stored. */
export function objectNameOf(d: Drawing): string {
  return d.name ?? objectTypeName(d.kind);
}

/**
 * `OBJPROP_TIMEFRAMES` — is the object drawn on this period at all.
 *
 * MetaTrader hides an object entirely on a period its Visualization tab has unticked; it does not
 * grey it. An object with nothing stored is shown everywhere, which is the default.
 */
export const shownOn = (d: Drawing, timeframe: string): boolean =>
  d.timeframes === undefined || d.timeframes.includes(timeframe);

/**
 * The levels an object starts with, which MetaTrader's Levels tab shows and its "Default" button
 * restores.
 *
 * Descriptions are MetaTrader's own: a Fibonacci Retracement's nine levels are described by their
 * percentage, "0.0" through "423.6", which is exactly what MetaQuotes' screenshot of the tab
 * shows. The Fibonacci tools' values are from their own help pages (see
 * docs/mt5/07-objects-list-and-properties.md).
 *
 * Andrews' Pitchfork has a Levels tab and MetaQuotes documents no default values for it, so the
 * three lines this platform draws are listed: the median and the two teeth. Those three are ours,
 * not MetaTrader's, and are marked as such here rather than presented as sourced.
 */
export function defaultLevelsOf(kind: DrawingKind): readonly ObjectLevel[] {
  const pct = (v: number): ObjectLevel => ({ value: v, text: (v * 100).toFixed(1) });
  switch (kind) {
    case 'fib': return FIB_LEVELS.map(pct);
    case 'fibFan':
    case 'fibArcs': return FIB_FAN_LEVELS.map(pct);
    case 'fibExpansion': return FIB_EXPANSION_LEVELS.map(pct);
    case 'fibChannel': return FIB_CHANNEL_LEVELS.map(pct);
    case 'fibTimeZones': return FIB_TIME_ZONES.map((v) => ({ value: v, text: String(v) }));
    case 'pitchfork': return [pct(0), pct(0.5), pct(1)];
    default: return [];
  }
}

/**
 * MetaTrader's `Pips per bar:` for a Gann object, as a price change per SECOND, which is what the
 * geometry takes. A "pip" here is the symbol's own point, 10^-digits, and the sign comes from the
 * `Downtrend` checkbox.
 */
export function gannUnitPerSecond(d: Drawing, barSeconds: number, digits: number): number | undefined {
  if (d.pipsPerBar === undefined || barSeconds <= 0) return undefined;
  const point = 10 ** -digits;
  return ((d.downtrend === true ? -1 : 1) * d.pipsPerBar * point) / barSeconds;
}

/**
 * The reverse: what a Gann object's own anchors amount to in `Pips per bar:`, so the dialog can
 * show the object's real scale rather than a number it is not using.
 */
export function gannPipsPerBar(d: Drawing, barSeconds: number, digits: number): number | undefined {
  if (d.pipsPerBar !== undefined) return d.pipsPerBar;
  const [a, b] = d.points;
  if (!a || !b || b.time === a.time || barSeconds <= 0) return undefined;
  const perBar = ((b.price - a.price) / (b.time - a.time)) * barSeconds;
  return Math.abs(perBar) / 10 ** -digits;
}

/**
 * Where a selected object's square markers go.
 *
 * MetaTrader: "Click on an object to select it. Square markers or frames appear for a selected
 * object. The markers are used for moving objects and changing their drawing parameters", and
 * "the object moving point is its central point as a rule".
 *
 * So every anchor gets a marker, and most objects get one more in the middle that moves the whole
 * object without reshaping it. The Gann objects do not: MetaQuotes says a Gann Fan has "two points,
 * both on the 1x1 trendline", and its slope is changed through Pips per bar rather than by dragging.
 * Andrews' Pitchfork's fourth marker is the midpoint of its two teeth, which is the point
 * MetaQuotes describes as "the second point of the handle" and the one that moves it.
 *
 * Marker COLOUR and size are not specified anywhere in MetaQuotes' help and are not legible in any
 * of its screenshots, so those are ours.
 *
 * The two anchors whose MIDPOINT carries the moving marker are returned, rather than the midpoint
 * itself, because the midpoint is taken in PIXELS at paint time: a chart-space midpoint falls
 * between two bars and the chart will not always map a time that no bar sits on.
 */
export function moveHandleOf(d: Drawing): [number, number] | null {
  if (d.kind === 'gannLine' || d.kind === 'gannFan' || d.kind === 'gannGrid') return null;
  // The pitchfork's moving point is the midpoint of its two teeth, which is the point MetaQuotes
  // calls "the second point of the handle".
  if (d.kind === 'pitchfork') return d.points.length >= 3 ? [1, 2] : null;
  return d.points.length >= 2 ? [0, 1] : null;
}

/** Move every anchor of an object by the same time and price, which is what dragging it does. */
export function translateDrawing(d: Drawing, dTime: number, dPrice: number): Drawing {
  return { ...d, points: d.points.map((p) => ({ time: p.time + dTime, price: p.price + dPrice })) };
}
