/**
 * MetaTrader's chart templates.
 *
 * A template is everything that makes one chart look and behave the way it does, saved under a name
 * and applied to another: *"a chart template is a set of chart settings that can be applied to
 * other charts"*. In MetaTrader that is a `.tpl` file in `MQL5\Profiles\Templates`; here it is a
 * record in this device's storage, because there is no file system to put one in and a template is
 * a window preference like the symbol list and the panel height.
 *
 * What a template carries is what this chart actually has: the chart type, the period, the whole
 * `ChartProperties` record (every Common, Show and Colors setting the F8 dialog writes), and the
 * indicators applied to it. Objects are deliberately NOT in it, and that is MetaTrader's own rule:
 * a template holds settings and indicators, and drawn objects belong to the chart they were drawn
 * on. Applying a template to EURUSD must not stamp a trend line someone drew on gold across it.
 *
 * The four seeded templates are not decoration. Each is a set of real settings and real indicators
 * that this terminal applies, and each exists because a trader asks for exactly that chart: the
 * platform's own defaults, a trend-following chart, an oscillator chart, and a clean line chart for
 * a screenshot. MetaTrader ships `Default` for the same reason.
 */

import {
  DEFAULT_PROPERTIES, parseProperties, serializeProperties, type ChartProperties,
} from './chartProperties.js';

/** The chart types this terminal draws, which is MetaTrader's three plus the three it added. */
export type TemplateKind = 'candles' | 'bars' | 'line' | 'heikin' | 'area' | 'baseline';

export interface ChartTemplate {
  name: string;
  /** Null on a seeded template: it was not saved by anyone, it ships with the terminal. */
  savedAtMs: number | null;
  kind: TemplateKind;
  /** An MT5 period key (`M1`, `H4`, `D1`…), or null to leave the chart's own period alone. */
  timeframe: string | null;
  properties: ChartProperties;
  /** Catalogue ids from lib/chart/indicatorCatalog. */
  indicators: readonly string[];
  /** True for the four that ship with the terminal, which cannot be removed. */
  builtIn: boolean;
}

const KEY = 'pp-chart-templates';

/** MetaTrader's own name for the template a chart opens with, and the one it cannot delete. */
export const DEFAULT_TEMPLATE_NAME = 'Default';

/**
 * The templates this terminal ships.
 *
 * `timeframe: null` on all four on purpose: MetaTrader's `Default` does not throw a chart onto
 * another period when it is applied, and a trader applying "Oscillator" to an H4 chart wants the
 * oscillators, not M1.
 */
export const BUILT_IN_TEMPLATES: readonly ChartTemplate[] = [
  {
    name: DEFAULT_TEMPLATE_NAME,
    savedAtMs: null,
    kind: 'candles',
    timeframe: null,
    properties: DEFAULT_PROPERTIES,
    indicators: [],
    builtIn: true,
  },
  {
    name: 'Trend following',
    savedAtMs: null,
    kind: 'candles',
    timeframe: null,
    // Period separators on, because a trend is read against the session it formed in.
    properties: { ...DEFAULT_PROPERTIES, showGrid: true, showPeriodSeparators: true },
    // Three moving averages and a band, all drawn on the price itself, which is what a
    // trend-following chart is: nothing in a sub-pane competing for the eye.
    indicators: ['ma', 'bollinger'],
    builtIn: true,
  },
  {
    name: 'Oscillator',
    savedAtMs: null,
    kind: 'candles',
    timeframe: null,
    properties: { ...DEFAULT_PROPERTIES, showGrid: true },
    // Both in their own panes under the price, which is where MetaTrader puts an oscillator.
    indicators: ['rsi', 'macd'],
    builtIn: true,
  },
  {
    name: 'Clean',
    savedAtMs: null,
    kind: 'line',
    timeframe: null,
    // Everything off: the chart a trader screenshots, or reads on a small window.
    properties: {
      ...DEFAULT_PROPERTIES,
      kind: 'line',
      showGrid: false,
      showPeriodSeparators: false,
      showOHLC: false,
      showTradeLevels: false,
    },
    indicators: [],
    builtIn: true,
  },
];

const isTemplateKind = (x: unknown): x is TemplateKind =>
  x === 'candles' || x === 'bars' || x === 'line' || x === 'heikin' || x === 'area' || x === 'baseline';

/** What is written to storage: the properties go through the same serializer the chart uses. */
interface StoredTemplate {
  name: string;
  savedAtMs: number;
  kind: TemplateKind;
  timeframe: string | null;
  properties: string;
  indicators: string[];
}

function parseStored(raw: string | null): ChartTemplate[] {
  if (!raw) return [];
  try {
    const got = JSON.parse(raw) as unknown;
    if (!Array.isArray(got)) return [];
    const out: ChartTemplate[] = [];
    for (const t of got as StoredTemplate[]) {
      if (typeof t?.name !== 'string' || t.name.trim() === '') continue;
      // A name that collides with a seeded one is dropped rather than shadowing it: the four that
      // ship are the ones a trader falls back to when a saved chart goes wrong.
      if (BUILT_IN_TEMPLATES.some((b) => b.name === t.name)) continue;
      out.push({
        name: t.name,
        savedAtMs: typeof t.savedAtMs === 'number' ? t.savedAtMs : 0,
        kind: isTemplateKind(t.kind) ? t.kind : 'candles',
        timeframe: typeof t.timeframe === 'string' ? t.timeframe : null,
        properties: parseProperties(typeof t.properties === 'string' ? t.properties : null),
        indicators: Array.isArray(t.indicators) ? t.indicators.filter((x): x is string => typeof x === 'string') : [],
        builtIn: false,
      });
    }
    return out;
  } catch { return []; }
}

const read = (): ChartTemplate[] => {
  try { return parseStored(window.localStorage.getItem(KEY)); } catch { return []; }
};

const write = (saved: readonly ChartTemplate[]): void => {
  const stored: StoredTemplate[] = saved.map((t) => ({
    name: t.name,
    savedAtMs: t.savedAtMs ?? Date.now(),
    kind: t.kind,
    timeframe: t.timeframe,
    properties: serializeProperties(t.properties),
    indicators: [...t.indicators],
  }));
  try { window.localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* private mode */ }
};

/**
 * Every template, the shipped ones first and the saved ones after, newest saved last.
 *
 * MetaTrader lists `Default` at the top of its submenu and the trader's own below it, which is the
 * order a trader looks in: the fallback first, then what they made.
 */
export function listTemplates(): ChartTemplate[] {
  const saved = read().sort((a, b) => (a.savedAtMs ?? 0) - (b.savedAtMs ?? 0));
  return [...BUILT_IN_TEMPLATES, ...saved];
}

/** The saved ones alone, which is what `Remove Template` offers: a shipped one cannot be removed. */
export function removableTemplates(): ChartTemplate[] {
  return listTemplates().filter((t) => !t.builtIn);
}

export function findTemplate(name: string): ChartTemplate | null {
  return listTemplates().find((t) => t.name === name) ?? null;
}

/**
 * Save the chart as a template under `name`, replacing one of that name.
 *
 * A name that collides with a shipped template is refused rather than silently renamed: a trader
 * who overwrites `Default` and then wants it back has nothing to go back to. The return says which
 * happened, so the dialog can report it instead of appearing to work.
 */
export function saveTemplate(
  t: Omit<ChartTemplate, 'builtIn' | 'savedAtMs'>,
): 'saved' | 'reserved' | 'empty' {
  const name = t.name.trim();
  if (name === '') return 'empty';
  if (BUILT_IN_TEMPLATES.some((b) => b.name === name)) return 'reserved';
  const saved = read().filter((x) => x.name !== name);
  write([...saved, { ...t, name, savedAtMs: Date.now(), builtIn: false }]);
  return 'saved';
}

/** Remove a saved template. A shipped one is never removed, which is what `builtIn` is for. */
export function deleteTemplate(name: string): void {
  write(read().filter((t) => t.name !== name && !BUILT_IN_TEMPLATES.some((b) => b.name === t.name)));
}

/** Test seam. */
export function resetTemplates(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* blocked storage */ }
}
