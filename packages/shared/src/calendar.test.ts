import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarBetween, calendarRange, calendarFigure, CALENDAR_CURRENCIES, CALENDAR_PERIODS,
} from "./calendar.js";

/**
 * The calendar's claims are schedule and determinism, so those are what is pinned.
 *
 * The figures are this platform's own and there is nothing to check them against; what CAN be
 * checked is that they never move, never leave their band, and that the columns agree with each
 * other the way a real calendar's do.
 */

const MS_DAY = 86_400_000;
const WEEK = Date.UTC(2026, 9, 5); // Monday 5 October 2026
const NOW = WEEK + 3 * MS_DAY;     // Thursday of that week

test("the same instant always produces the same calendar", () => {
  const a = calendarBetween(WEEK, WEEK + 30 * MS_DAY, NOW);
  const b = calendarBetween(WEEK, WEEK + 30 * MS_DAY, NOW);
  assert.deepEqual(a, b, "a second call is identical");
  assert.ok(a.length > 0, "the window is not empty");
  // And a DIFFERENT process would agree, which is what the hash buys: the values are a pure
  // function of the event id and its instant, with nothing from Date.now or Math.random in them.
  const again = calendarBetween(WEEK, WEEK + 30 * MS_DAY, NOW + 1_000);
  const sameIds = again.filter((e) => e.atMs <= NOW).map((e) => `${e.id}=${e.actual}`);
  const firstIds = a.filter((e) => e.atMs <= NOW).map((e) => `${e.id}=${e.actual}`);
  assert.deepEqual(sameIds, firstIds, "moving `now` does not change a reading that already printed");
});

test("the schedules are the real ones", () => {
  const month = calendarBetween(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31, 23, 59), NOW);

  // US Nonfarm Payrolls: the FIRST FRIDAY of the month. 2 October 2026 is a Friday.
  const nfp = month.filter((e) => e.event === "Nonfarm Payrolls");
  assert.equal(nfp.length, 1, "payrolls print once a month");
  const nfpDate = new Date(nfp[0]!.atMs);
  assert.equal(nfpDate.getUTCDay(), 5, "on a Friday");
  assert.ok(nfpDate.getUTCDate() <= 7, `in the first week (got the ${nfpDate.getUTCDate()})`);
  assert.equal(nfpDate.getUTCHours(), 13, "at 13:30 UTC, which is 08:30 New York");
  assert.equal(nfpDate.getUTCMinutes(), 30);

  // US initial jobless claims: EVERY Thursday.
  const claims = month.filter((e) => e.event === "Initial Jobless Claims");
  assert.ok(claims.length >= 4, `weekly, so four or five in a month (got ${claims.length})`);
  for (const c of claims) assert.equal(new Date(c.atMs).getUTCDay(), 4, "on a Thursday");
  // Consecutive ones are exactly a week apart.
  for (let i = 1; i < claims.length; i++) {
    assert.equal(claims[i]!.atMs - claims[i - 1]!.atMs, 7 * MS_DAY, "a week apart");
  }
});

test("a reading is published only once its release has passed", () => {
  const events = calendarBetween(WEEK, WEEK + 7 * MS_DAY, NOW);
  for (const e of events) {
    if (e.atMs <= NOW) assert.ok(e.actual !== null, `${e.event} has printed, so it has an actual`);
    else assert.equal(e.actual, null, `${e.event} is still to come, so it has none`);
    // A forecast exists either way: that is the point of a forecast.
    assert.ok(e.forecast !== null, `${e.event} carries a forecast`);
  }
});

test("every figure stays inside its indicator's plausible band", () => {
  // A year, so every indicator and many occurrences of each are covered.
  const year = calendarBetween(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), Date.UTC(2026, 11, 31));
  const byEvent = new Map<string, { min: number; max: number }>();
  for (const e of year) {
    for (const v of [e.actual, e.forecast, e.previous]) {
      if (v === null) continue;
      assert.ok(Number.isFinite(v), `${e.event} is a number`);
      const cur = byEvent.get(e.event) ?? { min: v, max: v };
      byEvent.set(e.event, { min: Math.min(cur.min, v), max: Math.max(cur.max, v) });
    }
  }
  // An unemployment rate of 40% or a Fed rate of -3% would be the giveaway that the bands are not
  // being honoured; these two are checked by name because they are the ones a trader reads first.
  const unemp = byEvent.get("Unemployment Rate")!;
  assert.ok(unemp.min >= 3.4 && unemp.max <= 4.6, `unemployment stays plausible (${unemp.min}..${unemp.max})`);
  const fed = byEvent.get("Fed Interest Rate Decision")!;
  assert.ok(fed.min >= 3.75 && fed.max <= 5.5, `the Fed rate stays plausible (${fed.min}..${fed.max})`);
  assert.ok(byEvent.size >= 20, `the year covers the whole indicator set (${byEvent.size})`);
});

test("previous is the reading this indicator actually printed last time", () => {
  const year = calendarBetween(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), Date.UTC(2026, 11, 31));
  const nfp = year.filter((e) => e.event === "Nonfarm Payrolls");
  assert.ok(nfp.length >= 11, "payrolls print monthly");
  for (let i = 1; i < nfp.length; i++) {
    assert.equal(
      nfp[i]!.previous, nfp[i - 1]!.actual,
      "each month's Previous is the month before's Actual, so the column agrees with the row above",
    );
  }
});

test("the period column names the period the reading covers, not the one it lands in", () => {
  const events = calendarBetween(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31), Date.UTC(2026, 9, 31));
  const nfp = events.find((e) => e.event === "Nonfarm Payrolls")!;
  // Released in October, covering September.
  assert.equal(nfp.period, "September");
  // A rate decision covers no period at all, so the cell is blank rather than invented.
  const fomc = events.find((e) => e.event === "Fed Interest Rate Decision");
  if (fomc) assert.equal(fomc.period, "");
});

test("calendarRange: weeks run Monday to Monday around the given instant", () => {
  const thisWeek = calendarRange("thisWeek", NOW);
  assert.equal(new Date(thisWeek.fromMs).getUTCDay(), 1, "starts on a Monday");
  assert.equal(thisWeek.fromMs, WEEK);
  assert.equal(thisWeek.toMs - thisWeek.fromMs, 7 * MS_DAY - 1, "a whole week");

  const prev = calendarRange("prevWeek", NOW);
  assert.equal(prev.fromMs, WEEK - 7 * MS_DAY);
  const next = calendarRange("nextWeek", NOW);
  assert.equal(next.fromMs, WEEK + 7 * MS_DAY);

  const month = calendarRange("thisMonth", NOW);
  assert.equal(new Date(month.fromMs).getUTCDate(), 1, "a month starts on the 1st");
  assert.equal(new Date(month.toMs).getUTCMonth(), new Date(NOW).getUTCMonth(), "and ends in the same month");
  assert.equal(CALENDAR_PERIODS.length, 6, "MetaTrader's three weeks and three months");
});

test("calendarFigure: the Calendar's own typography, not the account strip's", () => {
  // docs/mt5/09-toolbox.md 861: a COMMA thousands separator and NO space before `%`.
  assert.equal(calendarFigure(1050, "B", 1), "1,050.0B");
  assert.equal(calendarFigure(3.4, "%", 1), "3.4%");
  assert.equal(calendarFigure(-5.2, "M", 1), "-5.2M");
  assert.equal(calendarFigure(52.8, "", 1), "52.8");
  assert.equal(calendarFigure(231, "K", 0), "231K");
  // An unpublished reading is an EMPTY cell, not a dash or a zero.
  assert.equal(calendarFigure(null, "%", 1), "");
});

test("the calendar covers the currencies this platform quotes", () => {
  for (const c of ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]) {
    assert.ok(CALENDAR_CURRENCIES.includes(c), `${c} has releases`);
  }
});

test("a week is busy but not absurd", () => {
  const { fromMs, toMs } = calendarRange("thisWeek", NOW);
  const week = calendarBetween(fromMs, toMs, NOW);
  assert.ok(week.length >= 3, `a week has releases (${week.length})`);
  assert.ok(week.length <= 40, `and not an implausible wall of them (${week.length})`);
  // Oldest first, which is the order the grid draws.
  for (let i = 1; i < week.length; i++) assert.ok(week[i]!.atMs >= week[i - 1]!.atMs, "sorted by time");
});
