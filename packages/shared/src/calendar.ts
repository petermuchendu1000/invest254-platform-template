/**
 * The economic calendar, generated.
 *
 * MetaTrader fills its Calendar tab from a macroeconomic feed. There is no such feed behind this
 * platform, and this tab sat disabled saying so. A broker's terminal without a calendar is not a
 * broker's terminal, so the releases are generated here instead: REAL indicators, on their REAL
 * recurrence rules, with values drawn deterministically from a seed.
 *
 * Deterministic is the whole point. The same instant always produces the same calendar, on every
 * device and every reload, so a figure a trader read an hour ago is still the figure that is there;
 * nothing is randomised per render and nothing drifts. It is the same discipline the price curve
 * follows: seeded, reproducible, and checkable.
 *
 * What is NOT claimed: these are not the real world's published numbers. The schedule is real (US
 * Nonfarm Payrolls really is the first Friday, jobless claims really are every Thursday), the
 * indicators are real, the units and plausible ranges are real, and the arithmetic between actual,
 * forecast and previous is consistent. The figures themselves are this platform's own.
 */

// ───────────────────────────── types ─────────────────────────────

/**
 * MetaTrader's three importance levels, drawn as a blue fan: a dot, a dot with one arc, a dot with
 * two. MetaQuotes never names them (docs/mt5/09-toolbox.md 853), so they are numbered rather than
 * given words it does not use.
 */
export type CalendarPriority = 1 | 2 | 3;

/** How a figure is written: the suffix MetaTrader prints straight after the number. */
export type CalendarUnit = "%" | "K" | "M" | "B" | "";

export interface CalendarEvent {
  /** Stable across regenerations of the same instant, so a row can be keyed and selected. */
  id: string;
  /** Release time, epoch ms, UTC. */
  atMs: number;
  /** ISO 4217, the currency of the country the indicator is published for. */
  currency: string;
  /** The indicator's name, as a calendar prints it. */
  event: string;
  priority: CalendarPriority;
  /** The period the reading covers: a month name, a quarter, or empty where it has none. */
  period: string;
  /** Null until the release time has passed, which is exactly how a calendar reads. */
  actual: number | null;
  forecast: number | null;
  /** The last reading of the same indicator. Null for the first one in range. */
  previous: number | null;
  unit: CalendarUnit;
  decimals: number;
}

// ───────────────────────────── the indicators ─────────────────────────────

type Recurrence =
  /** The nth given weekday of the month, e.g. US Nonfarm Payrolls on the first Friday. */
  | { kind: "nthWeekday"; n: number; weekday: number }
  /** Every week on a given weekday, e.g. US initial jobless claims every Thursday. */
  | { kind: "weekly"; weekday: number }
  /** A day of the month, clamped into it. */
  | { kind: "monthDay"; day: number }
  /** The nth weekday of the first month of each quarter, for quarterly releases. */
  | { kind: "quarterly"; n: number; weekday: number };

interface Spec {
  id: string;
  currency: string;
  event: string;
  priority: CalendarPriority;
  unit: CalendarUnit;
  decimals: number;
  /** The plausible band a reading falls in. Values are drawn inside it and never outside. */
  band: readonly [number, number];
  /** Which period a reading covers, which decides what the Period column says. */
  periodKind: "month" | "quarter" | "week" | "none";
  /** UTC hour and minute of the release, which is what the Time column prints. */
  hour: number;
  minute: number;
  when: Recurrence;
}

/**
 * The indicators, with their real schedules.
 *
 * Chosen to cover the eight currencies this platform quotes and the releases that actually move
 * them, at the three importance levels a calendar separates: rate decisions and payrolls at the
 * top, inflation and growth in the middle, sentiment and inventories at the bottom.
 */
const SPECS: readonly Spec[] = [
  // ── USD ──────────────────────────────────────────────────────────────────────────────────────
  { id: "usd-nfp", currency: "USD", event: "Nonfarm Payrolls", priority: 3, unit: "K", decimals: 0, band: [75, 310], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 1, weekday: 5 } },
  { id: "usd-unemp", currency: "USD", event: "Unemployment Rate", priority: 3, unit: "%", decimals: 1, band: [3.4, 4.6], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 1, weekday: 5 } },
  { id: "usd-cpi", currency: "USD", event: "CPI y/y", priority: 3, unit: "%", decimals: 1, band: [2.1, 4.2], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 2, weekday: 3 } },
  { id: "usd-corecpi", currency: "USD", event: "Core CPI m/m", priority: 3, unit: "%", decimals: 1, band: [0.1, 0.5], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 2, weekday: 3 } },
  { id: "usd-fomc", currency: "USD", event: "Fed Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [3.75, 5.5], periodKind: "none", hour: 19, minute: 0, when: { kind: "nthWeekday", n: 3, weekday: 3 } },
  { id: "usd-retail", currency: "USD", event: "Retail Sales m/m", priority: 2, unit: "%", decimals: 1, band: [-0.6, 1.2], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 3, weekday: 4 } },
  { id: "usd-gdp", currency: "USD", event: "GDP q/q", priority: 2, unit: "%", decimals: 1, band: [-0.4, 3.6], periodKind: "quarter", hour: 13, minute: 30, when: { kind: "quarterly", n: 4, weekday: 4 } },
  { id: "usd-ism", currency: "USD", event: "ISM Manufacturing PMI", priority: 2, unit: "", decimals: 1, band: [45.2, 56.8], periodKind: "month", hour: 15, minute: 0, when: { kind: "nthWeekday", n: 1, weekday: 1 } },
  { id: "usd-claims", currency: "USD", event: "Initial Jobless Claims", priority: 1, unit: "K", decimals: 0, band: [190, 265], periodKind: "week", hour: 13, minute: 30, when: { kind: "weekly", weekday: 4 } },
  { id: "usd-oil", currency: "USD", event: "Crude Oil Inventories", priority: 1, unit: "M", decimals: 1, band: [-5.5, 6.2], periodKind: "week", hour: 15, minute: 30, when: { kind: "weekly", weekday: 3 } },
  { id: "usd-conf", currency: "USD", event: "CB Consumer Confidence", priority: 1, unit: "", decimals: 1, band: [95.0, 118.0], periodKind: "month", hour: 15, minute: 0, when: { kind: "nthWeekday", n: 4, weekday: 2 } },

  // ── EUR ──────────────────────────────────────────────────────────────────────────────────────
  { id: "eur-ecb", currency: "EUR", event: "ECB Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [2.0, 4.5], periodKind: "none", hour: 12, minute: 15, when: { kind: "nthWeekday", n: 2, weekday: 4 } },
  { id: "eur-cpi", currency: "EUR", event: "CPI Flash Estimate y/y", priority: 3, unit: "%", decimals: 1, band: [1.6, 3.4], periodKind: "month", hour: 10, minute: 0, when: { kind: "monthDay", day: 30 } },
  { id: "eur-gdp", currency: "EUR", event: "GDP q/q", priority: 2, unit: "%", decimals: 1, band: [-0.3, 0.9], periodKind: "quarter", hour: 10, minute: 0, when: { kind: "quarterly", n: 2, weekday: 5 } },
  { id: "eur-pmi", currency: "EUR", event: "Manufacturing PMI", priority: 2, unit: "", decimals: 1, band: [42.5, 54.0], periodKind: "month", hour: 9, minute: 0, when: { kind: "nthWeekday", n: 4, weekday: 3 } },
  { id: "eur-zew", currency: "EUR", event: "ZEW Economic Sentiment", priority: 1, unit: "", decimals: 1, band: [-18.0, 32.0], periodKind: "month", hour: 10, minute: 0, when: { kind: "nthWeekday", n: 2, weekday: 2 } },

  // ── GBP ──────────────────────────────────────────────────────────────────────────────────────
  { id: "gbp-boe", currency: "GBP", event: "BoE Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [3.75, 5.25], periodKind: "none", hour: 12, minute: 0, when: { kind: "nthWeekday", n: 1, weekday: 4 } },
  { id: "gbp-cpi", currency: "GBP", event: "CPI y/y", priority: 3, unit: "%", decimals: 1, band: [1.9, 4.4], periodKind: "month", hour: 7, minute: 0, when: { kind: "nthWeekday", n: 3, weekday: 3 } },
  { id: "gbp-gdp", currency: "GBP", event: "GDP m/m", priority: 2, unit: "%", decimals: 1, band: [-0.4, 0.6], periodKind: "month", hour: 7, minute: 0, when: { kind: "nthWeekday", n: 2, weekday: 5 } },
  { id: "gbp-retail", currency: "GBP", event: "Retail Sales m/m", priority: 2, unit: "%", decimals: 1, band: [-1.2, 1.4], periodKind: "month", hour: 7, minute: 0, when: { kind: "nthWeekday", n: 3, weekday: 5 } },

  // ── JPY ──────────────────────────────────────────────────────────────────────────────────────
  { id: "jpy-boj", currency: "JPY", event: "BoJ Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [-0.1, 0.75], periodKind: "none", hour: 3, minute: 0, when: { kind: "nthWeekday", n: 3, weekday: 5 } },
  { id: "jpy-cpi", currency: "JPY", event: "National Core CPI y/y", priority: 2, unit: "%", decimals: 1, band: [0.6, 3.3], periodKind: "month", hour: 23, minute: 30, when: { kind: "nthWeekday", n: 3, weekday: 4 } },

  // ── AUD / NZD / CAD / CHF ────────────────────────────────────────────────────────────────────
  { id: "aud-rba", currency: "AUD", event: "RBA Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [3.35, 4.6], periodKind: "none", hour: 3, minute: 30, when: { kind: "nthWeekday", n: 1, weekday: 2 } },
  { id: "aud-emp", currency: "AUD", event: "Employment Change", priority: 2, unit: "K", decimals: 1, band: [-12.0, 58.0], periodKind: "month", hour: 0, minute: 30, when: { kind: "nthWeekday", n: 3, weekday: 4 } },
  { id: "nzd-rbnz", currency: "NZD", event: "RBNZ Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [3.0, 5.5], periodKind: "none", hour: 1, minute: 0, when: { kind: "nthWeekday", n: 4, weekday: 3 } },
  { id: "cad-boc", currency: "CAD", event: "BoC Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [2.75, 5.0], periodKind: "none", hour: 14, minute: 45, when: { kind: "nthWeekday", n: 2, weekday: 3 } },
  { id: "cad-emp", currency: "CAD", event: "Employment Change", priority: 2, unit: "K", decimals: 1, band: [-18.0, 62.0], periodKind: "month", hour: 13, minute: 30, when: { kind: "nthWeekday", n: 1, weekday: 5 } },
  { id: "chf-snb", currency: "CHF", event: "SNB Interest Rate Decision", priority: 3, unit: "%", decimals: 2, band: [0.0, 1.75], periodKind: "none", hour: 8, minute: 30, when: { kind: "quarterly", n: 3, weekday: 4 } },
];

/** Every currency the calendar publishes for, which is what the filter offers. */
export const CALENDAR_CURRENCIES: readonly string[] =
  [...new Set(SPECS.map((s) => s.currency))].sort();

// ───────────────────────────── seeded values ─────────────────────────────

/**
 * A stable 32-bit hash. The same key always gives the same number, in this process and the next,
 * which is what makes the whole calendar reproducible.
 */
function hash(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A unit interval from a key, uniform enough for a plausible reading. */
const unit01 = (key: string): number => hash(key) / 4294967296;

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const MS_DAY = 86_400_000;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The nth given weekday of a month, or null where the month has no nth one. */
function nthWeekdayUtc(year: number, month: number, n: number, weekday: number): number | null {
  const first = Date.UTC(year, month, 1);
  const firstDow = new Date(first).getUTCDay();
  const delta = (weekday - firstDow + 7) % 7;
  const day = 1 + delta + (n - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return day > daysInMonth ? null : Date.UTC(year, month, day);
}

/** Every release instant for one indicator that falls inside the window. */
function occurrences(spec: Spec, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const at = (dayMs: number) => dayMs + spec.hour * 3_600_000 + spec.minute * 60_000;
  // A month of slack each side so an occurrence whose day sits outside the window but whose release
  // time falls inside it is not lost.
  const start = new Date(fromMs - 31 * MS_DAY);
  const end = new Date(toMs + 31 * MS_DAY);

  if (spec.when.kind === "weekly") {
    const w = spec.when.weekday;
    let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    d += ((w - new Date(d).getUTCDay() + 7) % 7) * MS_DAY;
    for (; d <= end.getTime(); d += 7 * MS_DAY) {
      const t = at(d);
      if (t >= fromMs && t <= toMs) out.push(t);
    }
    return out;
  }

  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
    for (let m = 0; m < 12; m++) {
      let dayMs: number | null = null;
      if (spec.when.kind === "nthWeekday") {
        dayMs = nthWeekdayUtc(y, m, spec.when.n, spec.when.weekday);
      } else if (spec.when.kind === "monthDay") {
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        dayMs = Date.UTC(y, m, Math.min(spec.when.day, daysInMonth));
      } else if (spec.when.kind === "quarterly") {
        if (m % 3 !== 0) continue;
        dayMs = nthWeekdayUtc(y, m, spec.when.n, spec.when.weekday);
      }
      if (dayMs === null) continue;
      const t = at(dayMs);
      if (t >= fromMs && t <= toMs) out.push(t);
    }
  }
  return out;
}

/** What the Period column says for a reading released at this instant. */
function periodOf(spec: Spec, atMs: number): string {
  const d = new Date(atMs);
  if (spec.periodKind === "none") return "";
  if (spec.periodKind === "week") {
    // A weekly series reports the week that just ended.
    const prior = new Date(atMs - 7 * MS_DAY);
    return `${MONTHS[prior.getUTCMonth()]!.slice(0, 3)} ${prior.getUTCDate()}`;
  }
  if (spec.periodKind === "quarter") {
    // Released in the quarter after the one it covers.
    const q = Math.floor(d.getUTCMonth() / 3);
    const prevQ = (q + 3) % 4;
    const year = q === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    return `Q${prevQ + 1} ${year}`;
  }
  // A monthly series reports the month before the one it is released in.
  const m = d.getUTCMonth();
  const prev = (m + 11) % 12;
  return MONTHS[prev]!;
}

/** A reading, drawn inside the indicator's plausible band and stable for that occurrence. */
function readingAt(spec: Spec, atMs: number): number {
  const [lo, hi] = spec.band;
  const u = unit01(`${spec.id}:${atMs}`);
  /**
   * Pulled toward the middle rather than flat across the band, because a macro series spends most
   * of its life near its centre and only occasionally prints an extreme. Averaging two draws is the
   * cheapest way to get that shape and keeps the result inside the band by construction.
   */
  const v = (u + unit01(`${spec.id}:${atMs}:b`)) / 2;
  return round(lo + v * (hi - lo), spec.decimals);
}

// ───────────────────────────── the calendar ─────────────────────────────

/**
 * Every release between two instants, oldest first.
 *
 * `nowMs` decides what has been published: an event at or before it carries an `actual`, one after
 * it does not, which is exactly how a calendar reads through the day. `forecast` is always present
 * once a release is within a month of now, because that is when an estimate exists.
 */
export function calendarBetween(fromMs: number, toMs: number, nowMs: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const spec of SPECS) {
    const times = occurrences(spec, fromMs, toMs);
    for (const atMs of times) {
      const actualValue = readingAt(spec, atMs);
      /**
       * The forecast is a near miss of the reading, not an independent draw. A calendar whose
       * forecasts bore no relation to the prints would colour half its rows red at random; the
       * interesting thing about the pair is that they are usually close and occasionally are not.
       */
      const [lo, hi] = spec.band;
      const missScale = (hi - lo) * 0.12;
      const miss = (unit01(`${spec.id}:${atMs}:f`) - 0.5) * 2 * missScale;
      const forecast = round(Math.min(hi, Math.max(lo, actualValue - miss)), spec.decimals);
      // The previous reading is the one this indicator actually printed last time, so the column
      // agrees with the row above it wherever both are in range.
      const prevTimes = occurrences(spec, atMs - 400 * MS_DAY, atMs - 1);
      const prevAt = prevTimes.length ? prevTimes[prevTimes.length - 1]! : null;
      out.push({
        id: `${spec.id}:${atMs}`,
        atMs,
        currency: spec.currency,
        event: spec.event,
        priority: spec.priority,
        period: periodOf(spec, atMs),
        actual: atMs <= nowMs ? actualValue : null,
        forecast,
        previous: prevAt === null ? null : readingAt(spec, prevAt),
        unit: spec.unit,
        decimals: spec.decimals,
      });
    }
  }
  out.sort((a, b) => a.atMs - b.atMs || a.currency.localeCompare(b.currency) || a.event.localeCompare(b.event));
  return out;
}

/** MetaTrader's period options: previous, current and next week, and the same three months. */
export type CalendarPeriod = "prevWeek" | "thisWeek" | "nextWeek" | "prevMonth" | "thisMonth" | "nextMonth";

export const CALENDAR_PERIODS: ReadonlyArray<{ key: CalendarPeriod; label: string }> = [
  { key: "prevWeek", label: "Previous week" },
  { key: "thisWeek", label: "Current week" },
  { key: "nextWeek", label: "Next week" },
  { key: "prevMonth", label: "Previous month" },
  { key: "thisMonth", label: "Current month" },
  { key: "nextMonth", label: "Next month" },
];

/**
 * The window a period covers.
 *
 * Weeks run Monday to Monday, which is the week MetaTrader's own History period presets use and the
 * week its calendar screenshots show.
 */
export function calendarRange(period: CalendarPeriod, nowMs: number): { fromMs: number; toMs: number } {
  const d = new Date(nowMs);
  if (period.endsWith("Week")) {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * MS_DAY;
    const shift = period === "prevWeek" ? -7 : period === "nextWeek" ? 7 : 0;
    const from = monday + shift * MS_DAY;
    return { fromMs: from, toMs: from + 7 * MS_DAY - 1 };
  }
  const shift = period === "prevMonth" ? -1 : period === "nextMonth" ? 1 : 0;
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift, 1);
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift + 1, 1) - 1;
  return { fromMs: from, toMs: to };
}

/**
 * A calendar figure, in the calendar's own typography.
 *
 * docs/mt5/09-toolbox.md 861: the Calendar writes a COMMA thousands separator and NO space before
 * `%`, which is the opposite of the account summary strip's space separator and spaced `%`. Both
 * appear in MetaQuotes' own screenshots, so both are reproduced rather than unified.
 */
export function calendarFigure(value: number | null, unit: CalendarUnit, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs);
  const frac = decimals > 0 ? (abs - whole).toFixed(decimals).slice(1) : "";
  return `${sign}${whole.toLocaleString("en-US")}${frac}${unit}`;
}
