/**
 * MetaTrader's Insert > Objects tree, as data.
 *
 * MetaQuotes' help enumerates 44 analytical objects in eight groups, and `ENUM_OBJECT` lists
 * exactly 44 object types, so 44 is the number this file carries. (The help prose twice claims 46;
 * its own category pages and the API disagree with it. That contradiction is recorded in
 * docs/mt5/03-chart-ui.md rather than silently resolved.)
 *
 * The group order is MetaTrader's own: Lines, Channels, Gann, Fibonacci, Elliott, Shapes, Arrows,
 * Graphical. Text and Text Label live inside Graphical, not as a separate branch.
 *
 * Seven of the Graphical nine are objects an Expert Advisor creates, not ones a trader draws:
 * Button, Graph, Bitmap, Bitmap Label, Edit, Event and Rectangle Label exist so MQL5 programs can
 * put controls on a chart. This platform runs no Expert Advisors, so they are listed and marked
 * unavailable with the reason, the same way the volume-fed indicators are: the tree stays checkable
 * against MetaTrader's menu, and nothing pretends to work that cannot.
 */

export type ObjectGroup =
  | 'lines' | 'channels' | 'gann' | 'fibonacci' | 'elliott' | 'shapes' | 'arrows' | 'graphical';

export const OBJECT_GROUP_LABELS: Record<ObjectGroup, string> = {
  lines: 'Lines',
  channels: 'Channels',
  gann: 'Gann',
  fibonacci: 'Fibonacci',
  elliott: 'Elliott',
  shapes: 'Shapes',
  arrows: 'Arrows',
  graphical: 'Graphical',
};

export interface ObjectDef {
  /** Our drawing kind, or null where the object exists in MetaTrader but cannot be drawn here. */
  kind: string | null;
  /** Exactly as MetaTrader's Insert menu writes it. */
  name: string;
  group: ObjectGroup;
  /** Anchors the trader places before the object is complete. */
  anchors: number;
  /** Set where MetaTrader has it and this platform cannot. */
  unavailable?: string;
  /**
   * The text MetaTrader gives the object when it is created, for the two objects that carry text.
   * `OBJ_TEXT` and `OBJ_LABEL` hold their text in `OBJPROP_TEXT`, which is the same field the
   * Objects List prints in its Description column, so there is one field and not two.
   */
  defaultText?: string;
  /**
   * MetaTrader's own token for the type in an object NAME and in the Objects List's Object column,
   * where it differs from the Insert menu's label. Read off MetaQuotes' screenshots: a Fibonacci
   * Retracement is named "M1 Fibo 26637", a Standard Deviation Channel lists as "StdDev Channel",
   * and Andrews' Pitchfork drops its apostrophe. Absent means the menu label is used.
   */
  token?: string;
}

const NO_EA = 'An Expert Advisor object. This platform runs no Expert Advisors.';

export const OBJECTS: readonly ObjectDef[] = [
  // ── Lines (6) ──
  { kind: 'horizontal', name: 'Horizontal Line', group: 'lines', anchors: 1 },
  { kind: 'vertical', name: 'Vertical Line', group: 'lines', anchors: 1 },
  { kind: 'trend', name: 'Trendline', group: 'lines', anchors: 2 },
  { kind: 'trendAngle', name: 'Trendline by Angle', group: 'lines', anchors: 2 },
  { kind: 'cycleLines', name: 'Cycle Lines', group: 'lines', anchors: 2 },
  { kind: 'arrowedLine', name: 'Arrowed Line', group: 'lines', anchors: 2 },

  // ── Channels (4) ──
  { kind: 'channelEquidistant', name: 'Equidistant Channel', group: 'channels', anchors: 3 },
  { kind: 'channelStdDev', name: 'Standard Deviation Channel', group: 'channels', anchors: 2, token: 'StdDev Channel' },
  { kind: 'channelRegression', name: 'Regression Channel', group: 'channels', anchors: 2 },
  { kind: 'pitchfork', name: "Andrews' Pitchfork", group: 'channels', anchors: 3, token: 'Andrews Pitchfork' },

  // ── Gann (3) ──
  { kind: 'gannLine', name: 'Gann Line', group: 'gann', anchors: 2 },
  { kind: 'gannFan', name: 'Gann Fan', group: 'gann', anchors: 2 },
  { kind: 'gannGrid', name: 'Gann Grid', group: 'gann', anchors: 2 },

  // ── Fibonacci (6) ──
  { kind: 'fib', name: 'Fibonacci Retracement', group: 'fibonacci', anchors: 2, token: 'Fibo' },
  { kind: 'fibTimeZones', name: 'Fibonacci Time Zones', group: 'fibonacci', anchors: 2 },
  { kind: 'fibFan', name: 'Fibonacci Fan', group: 'fibonacci', anchors: 2 },
  { kind: 'fibArcs', name: 'Fibonacci Arcs', group: 'fibonacci', anchors: 2 },
  { kind: 'fibChannel', name: 'Fibonacci Channel', group: 'fibonacci', anchors: 3 },
  { kind: 'fibExpansion', name: 'Fibonacci Expansion', group: 'fibonacci', anchors: 3 },

  // ── Elliott (2) ──
  { kind: 'elliottImpulse', name: 'Impulse Wave', group: 'elliott', anchors: 6 },
  { kind: 'elliottCorrection', name: 'Corrective Wave', group: 'elliott', anchors: 4 },

  // ── Shapes (3) ──
  { kind: 'rectangle', name: 'Rectangle', group: 'shapes', anchors: 2 },
  { kind: 'triangle', name: 'Triangle', group: 'shapes', anchors: 3 },
  { kind: 'ellipse', name: 'Ellipse', group: 'shapes', anchors: 2 },

  // ── Arrows (11) ──
  { kind: 'thumbsUp', name: 'Thumbs Up', group: 'arrows', anchors: 1 },
  { kind: 'thumbsDown', name: 'Thumbs Down', group: 'arrows', anchors: 1 },
  { kind: 'arrowUp', name: 'Up Arrow', group: 'arrows', anchors: 1 },
  { kind: 'arrowDown', name: 'Down Arrow', group: 'arrows', anchors: 1 },
  { kind: 'stopSign', name: 'Stop Sign', group: 'arrows', anchors: 1 },
  { kind: 'checkSign', name: 'Check Sign', group: 'arrows', anchors: 1 },
  { kind: 'leftPriceLabel', name: 'Left Price Label', group: 'arrows', anchors: 1 },
  { kind: 'rightPriceLabel', name: 'Right Price Label', group: 'arrows', anchors: 1 },
  { kind: 'buySign', name: 'Buy Sign', group: 'arrows', anchors: 1 },
  { kind: 'sellSign', name: 'Sell Sign', group: 'arrows', anchors: 1 },
  { kind: 'arrow', name: 'Arrow', group: 'arrows', anchors: 1 },

  // ── Graphical (9), of which seven are Expert Advisor objects ──
  { kind: 'text', name: 'Text', group: 'graphical', anchors: 1, defaultText: 'Text' },
  { kind: 'textLabel', name: 'Text Label', group: 'graphical', anchors: 1, defaultText: 'Label' },
  { kind: null, name: 'Button', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Graph', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Bitmap', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Bitmap Label', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Edit', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Event', group: 'graphical', anchors: 0, unavailable: NO_EA },
  { kind: null, name: 'Rectangle Label', group: 'graphical', anchors: 0, unavailable: NO_EA },
];

/** MetaTrader's count, pinned so the catalogue can be checked against its menu. */
export const MT5_OBJECT_COUNT = 44;

export const OBJECT_GROUPS: ReadonlyArray<{ group: ObjectGroup; label: string; items: readonly ObjectDef[] }> =
  (['lines', 'channels', 'gann', 'fibonacci', 'elliott', 'shapes', 'arrows', 'graphical'] as const)
    .map((group) => ({ group, label: OBJECT_GROUP_LABELS[group], items: OBJECTS.filter((o) => o.group === group) }));

export const DRAWABLE_OBJECTS: readonly ObjectDef[] = OBJECTS.filter((o) => o.kind !== null);

/** Keyed by our drawing kind, for the Objects List's Object column and for default naming. */
export const OBJECT_BY_KIND: Readonly<Record<string, ObjectDef>> =
  Object.fromEntries(OBJECTS.filter((o) => o.kind !== null).map((o) => [o.kind as string, o]));

/** The object's definition, or undefined for `measure`, which is ours and not an Insert object. */
export function objectOf(kind: string): ObjectDef | undefined {
  return OBJECT_BY_KIND[kind];
}

/**
 * MetaTrader's own name for an object type, as its Insert menu and the Objects List's Object column
 * write it. `measure` is the ruler, which is a crosshair drag in MetaTrader rather than an object,
 * so it gets the name MetaTrader's status bar uses for the same gesture.
 */
export function objectTypeName(kind: string): string {
  return OBJECT_BY_KIND[kind]?.name ?? (kind === 'measure' ? 'Measure' : kind);
}

/**
 * The token MetaTrader uses for the type inside an object's NAME and in the Objects List's Object
 * column. For most objects this is the menu label; for three of them MetaTrader abbreviates.
 */
export function objectToken(kind: string): string {
  const def = OBJECT_BY_KIND[kind];
  return def?.token ?? def?.name ?? (kind === 'measure' ? 'Measure' : kind);
}

/**
 * Which Object Properties tabs an object shows, and which fields its Parameters tab holds.
 *
 * MetaTrader shows three tabs on most objects and four on a few. Its help states the rule
 * outright: "The 'Levels' tab is specifically used only for Fibonacci tools and Andrews'
 * Pitchfork." A Rectangle, a Trendline, a Gann Line and a Gann Fan have no Levels tab, confirmed
 * from MetaQuotes' own screenshots of each. Our earlier guess gave one to the deviation channel
 * and the Gann Fan; it was wrong.
 *
 * Everything below is from docs/mt5/07-objects-list-and-properties.md, which carries the sources.
 */
const LEVELLED = new Set([
  'fib', 'fibTimeZones', 'fibFan', 'fibArcs', 'fibChannel', 'fibExpansion', 'pitchfork',
]);

/**
 * Which objects offer MetaTrader's Ray right / Ray left. Verified from screenshots for Trendline,
 * Fibonacci Retracement, Gann Line and Andrews' Pitchfork; the channels and the remaining Fibonacci
 * tools are taken with them because they are the same two-anchor line extended, and MetaQuotes has
 * not screenshotted their Parameters tabs.
 */
const RAYED = new Set([
  'trend', 'trendAngle', 'gannLine', 'pitchfork',
  'channelEquidistant', 'channelStdDev', 'channelRegression',
  'fib', 'fibFan', 'fibChannel', 'fibExpansion',
]);

/**
 * Which objects carry MetaTrader's `Fill` checkbox. Verified for Rectangle; the other two closed
 * shapes are taken with it, since the Common tab's own wording is "color filling of objects like
 * shapes or channels (excluding Fibonacci Channel)".
 */
const FILLABLE = new Set(['rectangle', 'triangle', 'ellipse']);

/**
 * The Gann objects' own Parameters fields. A Gann Fan has `Pips per bar:` and `Downtrend`; a Gann
 * Line has `Gann angle:` as well. MetaTrader's second anchor on both is a DATE with no paired
 * value, which is why they are listed here rather than treated as ordinary two-anchor objects.
 * The Gann Grid is taken with the Fan: MetaQuotes has not screenshotted its Parameters tab.
 */
const GANN_SCALED = new Set(['gannLine', 'gannFan', 'gannGrid']);

export const hasLevels = (kind: string): boolean => LEVELLED.has(kind);
export const hasRays = (kind: string): boolean => RAYED.has(kind);
export const hasFill = (kind: string): boolean => FILLABLE.has(kind);
export const hasGannScale = (kind: string): boolean => GANN_SCALED.has(kind);
export const hasGannAngle = (kind: string): boolean => kind === 'gannLine';

/**
 * Which anchor coordinates MetaTrader's Parameters tab actually offers.
 *
 * A Horizontal Line's tab holds a single `Value:` and no `Date:` at all, read off MetaQuotes'
 * screenshot of it. A Vertical Line is the mirror of that and is given `Date:` alone; MetaQuotes
 * has not screenshotted it, so that one is inferred rather than observed. The Gann objects' SECOND
 * anchor is a date with no value, which the screenshots do show.
 */
export function anchorFields(kind: string, index: number): { date: boolean; value: boolean } {
  if (kind === 'horizontal') return { date: false, value: true };
  if (kind === 'vertical') return { date: true, value: false };
  if (GANN_SCALED.has(kind) && index > 0) return { date: true, value: false };
  return { date: true, value: true };
}
