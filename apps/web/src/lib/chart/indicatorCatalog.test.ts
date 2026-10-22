import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDICATORS, INDICATOR_GROUPS, GROUP_LABELS, MT5_INDICATOR_COUNT } from './indicatorCatalog.js';

/**
 * MetaTrader's Navigator, written down. If this file and the terminal ever disagree, one of them is
 * wrong and it is almost certainly this one, so the list is pinned by name rather than by count
 * alone: a count passes just as happily with the wrong thirty-eight.
 *
 * Source: https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators
 */
const MT5 = {
  'Trend Indicators': [
    'Adaptive Moving Average',
    'Average Directional Movement Index',
    'Average Directional Movement Index Wilder',
    'Bollinger Bands®',
    'Double Exponential Moving Average',
    'Envelopes',
    'Fractal Adaptive Moving Average',
    'Ichimoku Kinko Hyo',
    'Moving Average',
    'Parabolic SAR',
    'Standard Deviation',
    'Triple Exponential Moving Average',
    'Variable Index Dynamic Average',
  ],
  'Oscillators': [
    'Average True Range',
    'Bears Power',
    'Bulls Power',
    'Chaikin Oscillator',
    'Commodity Channel Index',
    'DeMarker',
    'Force Index',
    'MACD',
    'Momentum',
    'Moving Average of Oscillator',
    'Relative Strength Index',
    'Relative Vigor Index',
    'Stochastic Oscillator',
    'Triple Exponential Average',
    "Williams' Percent Range",
  ],
  'Volume Indicators': [
    'Accumulation/Distribution',
    'Money Flow Index',
    'On Balance Volume',
    'Volumes',
  ],
  "Bill Williams' Indicators": [
    'Accelerator Oscillator',
    'Alligator',
    'Awesome Oscillator',
    'Fractals',
    'Gator Oscillator',
    'Market Facilitation Index',
  ],
} as const;

test('the catalogue carries every one of MetaTrader\'s 38 built-in indicators', () => {
  assert.equal(INDICATORS.length, MT5_INDICATOR_COUNT);
  assert.equal(Object.values(MT5).flat().length, MT5_INDICATOR_COUNT);
});

test('the four group names are MetaTrader\'s own, apostrophe and all', () => {
  assert.deepEqual(Object.values(GROUP_LABELS).sort(), Object.keys(MT5).slice().sort());
});

test('every group holds exactly the indicators MetaTrader puts in it', () => {
  for (const g of INDICATOR_GROUPS) {
    const expected = MT5[g.label as keyof typeof MT5];
    assert.ok(expected, `unknown group ${g.label}`);
    // Names are compared as sets: MetaTrader orders its Navigator alphabetically, and this
    // catalogue groups by pane for the menu, so order is deliberately not asserted.
    assert.deepEqual(
      g.items.map((i) => i.name).slice().sort(),
      expected.slice().sort(),
      `group ${g.label} does not match MetaTrader`,
    );
  }
});

test('ids are unique, because the chart keys its series off them', () => {
  const ids = INDICATORS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('exactly the seven volume-fed indicators are marked unavailable, and each says why', () => {
  const blocked = INDICATORS.filter((i) => i.unavailable).map((i) => i.name).sort();
  assert.deepEqual(blocked, [
    'Accumulation/Distribution',
    'Chaikin Oscillator',
    'Force Index',
    'Market Facilitation Index',
    'Money Flow Index',
    'On Balance Volume',
    'Volumes',
  ]);
  for (const i of INDICATORS) {
    if (i.unavailable) assert.match(i.unavailable, /volume/i, `${i.name} must say why`);
  }
});

test('every available indicator actually computes something on a real series', () => {
  const bars = Array.from({ length: 300 }, (_, i) => {
    const base = 100 + Math.sin(i / 5) * 5 + i * 0.1;
    return { time: i, open: base, high: base + 1, low: base - 1, close: base + Math.cos(i / 3) * 0.5 };
  });
  for (const ind of INDICATORS) {
    if (ind.unavailable) continue;
    const plots = ind.compute(bars);
    assert.ok(plots.length > 0, `${ind.name} produced no plots`);
    for (const p of plots) {
      assert.equal(p.values.length, bars.length, `${ind.name}/${p.key} is not index-aligned`);
      assert.ok(p.values.some((v) => v !== null), `${ind.name}/${p.key} is entirely null`);
    }
  }
});

test('an unavailable indicator computes nothing, so it can never draw a fabricated line', () => {
  const bars = Array.from({ length: 50 }, (_, i) => ({ time: i, open: 1, high: 2, low: 0, close: 1 }));
  for (const ind of INDICATORS) {
    if (!ind.unavailable) continue;
    assert.equal(ind.compute(bars).length, 0, `${ind.name} should produce no plots`);
  }
});
