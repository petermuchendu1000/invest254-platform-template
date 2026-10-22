import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOUR_FIELDS, SCHEMES, SCHEME_NAMES, SHOW_ROWS, CHART_KINDS, DEFAULT_PROPERTIES,
  MT5_COLOUR_FIELD_COUNT, MT5_SCHEME_COUNT, MT5_SHOW_ROW_COUNT,
  applyShowRules, clampScale, clampShift, parseProperties, serializeProperties,
  tickVolumesBlocked,
  type ChartProperties,
} from './chartProperties.js';

/**
 * MetaTrader's Chart Properties (F8), written down and pinned BY LABEL, because a count passes just
 * as happily with the wrong thirteen.
 *
 * Source: docs/mt5/08-chart-properties.md, built from MetaQuotes' own dialog screenshots. Where its
 * prose and its dialog disagree the dialog wins, and these tests assert the dialog's strings.
 */

test("the Colors tab carries MetaTrader's thirteen fields, in its order and with its colons", () => {
  assert.equal(COLOUR_FIELDS.length, MT5_COLOUR_FIELD_COUNT);
  assert.deepEqual(COLOUR_FIELDS.map((f) => f.label), [
    'Background:', 'Foreground:', 'Grid:', 'Bar up:', 'Bar down:', 'Bull candle:', 'Bear candle:',
    'Line chart:', 'Volumes:', 'Bid price line:', 'Ask price line:', 'Last price line:',
    'Stop levels:',
  ]);
  // Field 2 is "Foreground:" in the dialog. MetaQuotes' prose calls it "Text" in English and
  // "Текст" in Russian; both are wrong, and CHART_COLOR_FOREGROUND agrees with the dialog.
  assert.equal(COLOUR_FIELDS[1]!.label, 'Foreground:');
  // Every field carries a colour in every scheme, so no scheme can leave one unset.
  for (const name of SCHEME_NAMES) {
    for (const f of COLOUR_FIELDS) {
      assert.match(SCHEMES[name][f.id], /^#[0-9a-f]{6}$/i, `${name} ${f.id}`);
    }
  }
});

test("the Scheme dropdown is MetaTrader's four, and there is no Custom", () => {
  assert.equal(SCHEME_NAMES.length, MT5_SCHEME_COUNT);
  assert.deepEqual([...SCHEME_NAMES], [
    'Yellow on Black', 'Green on Black', 'Black on White', 'Color on White',
  ]);
  // A scheme the trader alters becomes a template in MetaTrader, not a fifth entry in this list.
  assert.ok(!SCHEME_NAMES.some((n) => /custom/i.test(n)));
});

test("Black on White is MetaQuotes' own, field for field", () => {
  // The one scheme MetaQuotes publishes values for. The other three it never states, anywhere.
  const s = SCHEMES['Black on White'];
  assert.equal(s.background, '#ffffff');
  assert.equal(s.foreground, '#000000');
  assert.equal(s.grid, '#c0c0c0');
  assert.equal(s.barUp, '#000000');
  assert.equal(s.barDown, '#000000');
  assert.equal(s.bullCandle, '#ffffff');
  assert.equal(s.bearCandle, '#000000');
  assert.equal(s.lineChart, '#000000');
  assert.equal(s.volumes, '#008000');
  assert.equal(s.bidLine, '#c0c0c0');
  assert.equal(s.askLine, '#c0c0c0');
  assert.equal(s.lastLine, '#c0c0c0');
  assert.equal(s.stopLevels, '#ff4500');
});

test('each scheme honours what its own name asserts', () => {
  assert.equal(SCHEMES['Yellow on Black'].background, '#000000');
  assert.equal(SCHEMES['Yellow on Black'].foreground, '#ffff00');
  assert.equal(SCHEMES['Green on Black'].background, '#000000');
  assert.equal(SCHEMES['Green on Black'].foreground, '#00ff00');
  assert.equal(SCHEMES['Color on White'].background, '#ffffff');
  // "Color on White" differs from "Black on White" by having coloured bars rather than black ones.
  assert.notEqual(SCHEMES['Color on White'].barUp, SCHEMES['Black on White'].barUp);
});

test("the Show tab is MetaTrader's thirteen, in its order and its sentence case", () => {
  assert.equal(SHOW_ROWS.length, MT5_SHOW_ROW_COUNT);
  assert.deepEqual(SHOW_ROWS.map((r) => r.label), [
    'Show ticker', 'Show OHLC', 'Show quick trading buttons',
    'Show bid price line', 'Show ask price line', 'Show last price line',
    'Show period separators', 'Show grid', 'Show tick volumes', 'Show real volumes',
    'Show object descriptions', 'Show trade levels', 'Show trade history',
  ]);
  // Neither of these is MetaTrader's: both are TradingView's vocabulary and were in our notes by
  // mistake. They must not creep back in.
  assert.ok(!SHOW_ROWS.some((r) => /watermark|period description/i.test(r.label)));
});

test('the rows this feed cannot honour are listed and say why', () => {
  const blocked = SHOW_ROWS.filter((r) => r.unavailable !== undefined).map((r) => r.label);
  assert.deepEqual(blocked, [
    'Show bid price line', 'Show ask price line', 'Show tick volumes', 'Show real volumes',
  ]);
  for (const r of SHOW_ROWS.filter((x) => x.unavailable)) {
    assert.ok(r.unavailable!.length > 20, r.label);
  }
});

test("the Common tab's chart types are MetaTrader's three, with its accelerators", () => {
  assert.deepEqual(CHART_KINDS.map((c) => c.label), ['Bar chart', 'Candlesticks', 'Line chart']);
  assert.deepEqual(CHART_KINDS.map((c) => c.accelerator), ['Alt+1', 'Alt+2', 'Alt+3']);
});

test('Show ticker and Show OHLC are coupled, and asymmetrically', () => {
  const on: ChartProperties = { ...DEFAULT_PROPERTIES, showTicker: true, showOHLC: true };
  // Unticking the ticker takes OHLC with it.
  assert.equal(applyShowRules(on, { showTicker: false }).showOHLC, false);
  // Ticking OHLC brings the ticker back.
  const off = applyShowRules(on, { showTicker: false });
  assert.equal(applyShowRules(off, { showOHLC: true }).showTicker, true);
  // But ticking the ticker on its own leaves OHLC alone.
  assert.equal(applyShowRules(off, { showTicker: true }).showOHLC, false);
});

test('tick and real volumes are one property with three values, not two checkboxes', () => {
  const p = applyShowRules(DEFAULT_PROPERTIES, { volumes: 'tick' });
  assert.equal(p.volumes, 'tick');
  // Choosing real replaces tick rather than joining it.
  assert.equal(applyShowRules(p, { volumes: 'real' }).volumes, 'real');
  assert.equal(applyShowRules(p, { volumes: 'hide' }).volumes, 'hide');
});

test('Scale fix takes tick volumes with it, and one to one takes Scale fix', () => {
  // "The option is unavailable with scale fix enabled" — stated for tick volumes only.
  const ticking = applyShowRules(DEFAULT_PROPERTIES, { volumes: 'tick' });
  const fixed = applyShowRules(ticking, { scaleFix: true });
  assert.equal(fixed.volumes, 'hide');
  assert.equal(tickVolumesBlocked(fixed), true);
  assert.equal(tickVolumesBlocked(DEFAULT_PROPERTIES), false);
  // Scale fix one to one ticks Scale fix, which is MetaTrader's own behaviour.
  const oneToOne = applyShowRules(DEFAULT_PROPERTIES, { scaleFixOneToOne: true });
  assert.equal(oneToOne.scaleFix, true);
});

test('the scale and the shift stay inside the ranges MetaTrader gives them', () => {
  // CHART_SCALE is an integer 0 to 5: six steps.
  assert.equal(clampScale(-3), 0);
  assert.equal(clampScale(9), 5);
  assert.equal(clampScale(2.4), 2);
  // CHART_SHIFT_SIZE is 10 to 50 per cent of the window width.
  assert.equal(clampShift(0), 10);
  assert.equal(clampShift(80), 50);
  assert.equal(clampShift(27.6), 28);
});

test('properties survive a reload, and a damaged record falls back rather than throwing', () => {
  const edited = applyShowRules(DEFAULT_PROPERTIES, { showGrid: false, scheme: 'Black on White' });
  const round = parseProperties(serializeProperties(edited));
  assert.equal(round.showGrid, false);
  assert.equal(round.scheme, 'Black on White');
  assert.deepEqual(parseProperties(null), DEFAULT_PROPERTIES);
  assert.deepEqual(parseProperties('not json'), DEFAULT_PROPERTIES);
  assert.deepEqual(parseProperties('null'), DEFAULT_PROPERTIES);
  // A record written before a colour existed still yields all thirteen.
  const partial = parseProperties(JSON.stringify({ colours: { grid: '#123456' } }));
  assert.equal(partial.colours.grid, '#123456');
  assert.equal(Object.keys(partial.colours).length, MT5_COLOUR_FIELD_COUNT);
});

test('a stored record cannot smuggle in a state the rules forbid', () => {
  // Scale fix on and tick volumes on cannot coexist, however the record got written.
  const smuggled = parseProperties(JSON.stringify({ scaleFix: true, volumes: 'tick' }));
  assert.equal(smuggled.volumes, 'hide');
});
