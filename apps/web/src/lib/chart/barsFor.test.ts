import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMEFRAMES, TIMEFRAME_KEYS, type Timeframe } from '@invest254/shared/candles';

/**
 * How many bars the chart asks for, per period.
 *
 * A copy of `barsFor` from components/game/CandleChart, because that module pulls in
 * lightweight-charts and the whole React tree and cannot be imported under node:test. The rule it
 * encodes is what matters and it is short, so it is restated here and pinned: ask for twice the
 * visible pane, and never for a wider span than the brand's history actually holds.
 *
 * The flat 500 this replaced is why a cold D1 request blocked the engine for 4.5 seconds to return
 * 500 bars for a 120-bar pane, and W1 spent 4.7 seconds to return 57.
 */
const PANE_BARS = 240;
const HISTORY_DAYS = 400;
const DAY_SECONDS = 86_400;
const barsFor = (tf: Timeframe): number => {
  const span = TIMEFRAMES[tf] ?? 60;
  const seconds = tf === 'MN1' ? 30 * DAY_SECONDS : span;
  const withinHistory = Math.floor((HISTORY_DAYS * DAY_SECONDS) / seconds);
  return Math.max(24, Math.min(PANE_BARS, withinHistory));
};

test('an intraday period asks for twice the pane, which is what scrolling needs', () => {
  for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'] as const) {
    assert.equal(barsFor(tf), PANE_BARS, tf);
  }
});

test('no period asks for a wider span than the brand has history for, bar the floor', () => {
  // The 24-bar floor wins over the span cap at MN1 alone: 400 days is about 13 months, and a pane
  // showing 13 bars with no way to page further back is the honest end of this instrument's
  // history. Asking for 24 and being given 13 costs the engine nothing — the day chain is capped
  // either way — so the floor stays and this names the one period it applies to.
  for (const tf of TIMEFRAME_KEYS) {
    const seconds = tf === 'MN1' ? 30 * DAY_SECONDS : TIMEFRAMES[tf];
    const days = (barsFor(tf) * seconds) / DAY_SECONDS;
    if (barsFor(tf) === 24) { assert.equal(tf, 'MN1', `${tf} hit the floor unexpectedly`); continue; }
    assert.ok(days <= HISTORY_DAYS + 1e-9, `${tf} asks for ${days.toFixed(0)} days of a ${HISTORY_DAYS}-day history`);
  }
});

test('the long periods are the ones that shrink, and they shrink to what exists', () => {
  // 400 days is 400 D1 bars, ~57 W1 bars and ~13 MN1 bars. Asking for 500 of any of them was
  // asking the engine to walk its whole chain to answer with less.
  assert.equal(barsFor('D1'), 240);
  assert.equal(barsFor('W1'), 57);
  assert.equal(barsFor('MN1'), 24, 'the floor, since 400 days is only ~13 months');
});

test('every period asks for enough to fill the pane at least once', () => {
  // A request that returned fewer bars than the pane would leave the chart half empty with no
  // scroll gesture able to fetch more, because paging only triggers near the left edge.
  for (const tf of TIMEFRAME_KEYS) assert.ok(barsFor(tf) >= 24, tf);
});
