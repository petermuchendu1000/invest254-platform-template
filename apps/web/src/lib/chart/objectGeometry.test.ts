import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHORS_NEEDED, FIB_LEVELS, GANN_RATIOS, equidistantChannel, extendRay, fibArcs, fibChannel,
  fibExpansion, fibFan, fibLines, fibTimeZones, gannFan, gannGrid, gannPipsPerBar,
  gannUnitPerSecond, linearRegression, nextObjectName, objectNameOf, regressionDeviation,
  dashOf, defaultLevelsOf, levelLabel, moveHandleOf, shownOn, translateDrawing, LINE_STYLES,
  type Anchor, type Drawing, type DrawingKind,
} from './drawings.js';
import { DRAWABLE_OBJECTS } from './objects.js';

const at = (time: number, price: number): Anchor => ({ time, price });

// ── the catalogue and the geometry must agree ─────────────────────────────────────────────────
test('every drawable object in the tree has an anchor count, and the two agree', () => {
  for (const o of DRAWABLE_OBJECTS) {
    const need = ANCHORS_NEEDED[o.kind as keyof typeof ANCHORS_NEEDED];
    assert.ok(need !== undefined, `${o.name} has no anchor count`);
    assert.equal(need, o.anchors, `${o.name}: tree says ${o.anchors}, geometry says ${need}`);
  }
});

// ── Fibonacci levels are MetaTrader's, not TradingView's ──────────────────────────────────────
test('Fibonacci retracement uses MetaTrader\'s nine levels, and 78.6 is not among them', () => {
  assert.deepEqual([...FIB_LEVELS], [0, 0.236, 0.382, 0.5, 0.618, 1, 1.618, 2.618, 4.236]);
  assert.ok(!FIB_LEVELS.includes(0.786), '78.6% is a TradingView level, not a MetaTrader one');
});

// ── rays ──────────────────────────────────────────────────────────────────────────────────────
test('extendRay keeps the direction and lengthens the run', () => {
  const r = extendRay(at(0, 10), at(10, 20), 4);
  assert.equal(r.a.time, 0);
  assert.equal(r.b.time, 40);
  assert.equal(r.b.price, 50); // the same slope, four times out
});

// ── channels ──────────────────────────────────────────────────────────────────────────────────
test('an equidistant channel is parallel: both lines share one slope', () => {
  const { base, parallel } = equidistantChannel(at(0, 10), at(10, 20), at(5, 20));
  const s = (l: { a: Anchor; b: Anchor }) => (l.b.price - l.a.price) / (l.b.time - l.a.time);
  assert.ok(Math.abs(s(base) - s(parallel)) < 1e-9);
});

test('the channel parallel passes through the third anchor', () => {
  const c = at(5, 20);
  const { parallel } = equidistantChannel(at(0, 10), at(10, 20), c);
  const slope = (parallel.b.price - parallel.a.price) / (parallel.b.time - parallel.a.time);
  const atC = parallel.a.price + slope * (c.time - parallel.a.time);
  assert.ok(Math.abs(atC - c.price) < 1e-9, `parallel sits at ${atC}, anchor at ${c.price}`);
});

// ── Gann ──────────────────────────────────────────────────────────────────────────────────────
test('the Gann fan has nine rays and the 1x1 runs through the second anchor', () => {
  const a = at(0, 100), b = at(10, 110);
  const fan = gannFan(a, b, 1);
  assert.equal(fan.length, GANN_RATIOS.length);
  const oneByOne = fan.find((f) => f.ratio === 1)!;
  assert.equal(oneByOne.label, '1x1');
  assert.ok(Math.abs(oneByOne.line.b.price - b.price) < 1e-9);
});

test('Gann ratios above one are steeper than the 1x1, and below one shallower', () => {
  const fan = gannFan(at(0, 100), at(10, 110), 1);
  const slope = (f: typeof fan[number]) => (f.line.b.price - f.line.a.price) / (f.line.b.time - f.line.a.time);
  const unit = slope(fan.find((f) => f.ratio === 1)!);
  for (const f of fan) {
    if (f.ratio > 1) assert.ok(slope(f) > unit, `${f.label} should be steeper`);
    if (f.ratio < 1) assert.ok(slope(f) < unit, `${f.label} should be shallower`);
  }
});

test('the Gann grid is centred on the first anchor and evenly spaced', () => {
  const { verticals, horizontals } = gannGrid(at(100, 50), at(110, 55), 3);
  assert.equal(verticals.length, 7);
  assert.ok(verticals.includes(100));
  const gaps = verticals.slice(1).map((v, i) => v - verticals[i]!);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]!) < 1e-9), 'spacing must be even');
  assert.ok(horizontals.includes(50));
});

// ── Fibonacci families ────────────────────────────────────────────────────────────────────────
test('the Fibonacci fan has three rays, all from the first anchor', () => {
  const a = at(0, 100);
  const fan = fibFan(a, at(10, 120));
  assert.equal(fan.length, 3);
  for (const f of fan) { assert.equal(f.line.a.time, a.time); assert.equal(f.line.a.price, a.price); }
});

test('Fibonacci time zones step by the Fibonacci sequence', () => {
  const z = fibTimeZones(at(0, 1), at(10, 2));
  assert.deepEqual(z.map((x) => x.step), [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
  assert.equal(z[0]!.time, 10);
  assert.equal(z[4]!.time, 80);
});

test('Fibonacci arcs grow with the ratio', () => {
  const arcs = fibArcs(at(0, 100), at(10, 110));
  const r = arcs.map((x) => Math.abs(x.dPrice));
  assert.ok(r[0]! < r[1]! && r[1]! < r[2]!, 'radii must increase');
});

test('Fibonacci expansion projects the impulse from the third anchor', () => {
  const exp = fibExpansion(at(0, 100), at(10, 120), at(20, 110));
  const hundred = exp.find((e) => e.ratio === 1)!;
  assert.equal(hundred.price, 130); // 110 + (120 - 100)
  assert.equal(hundred.label, '100%');
});

test('the Fibonacci channel includes its base line and stays parallel throughout', () => {
  const lines = fibChannel(at(0, 10), at(10, 20), at(5, 20));
  assert.ok(lines.length >= 2);
  const s = (l: { a: Anchor; b: Anchor }) => (l.b.price - l.a.price) / (l.b.time - l.a.time);
  const first = s(lines[0]!.line);
  for (const l of lines) assert.ok(Math.abs(s(l.line) - first) < 1e-9, 'every line must share the slope');
});

// ── regression ────────────────────────────────────────────────────────────────────────────────
test('a perfect line is fitted exactly, with zero deviation', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 3 * i + 7 }));
  const fit = linearRegression(pts);
  assert.ok(Math.abs(fit.slope - 3) < 1e-9);
  assert.ok(Math.abs(fit.intercept - 7) < 1e-9);
  assert.ok(regressionDeviation(pts, fit) < 1e-9);
});

test('noise around a line raises the deviation but not the slope', () => {
  const clean = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 2 * i }));
  const noisy = clean.map((p, i) => ({ x: p.x, y: p.y + (i % 2 ? 1 : -1) }));
  const f1 = linearRegression(clean), f2 = linearRegression(noisy);
  assert.ok(Math.abs(f1.slope - f2.slope) < 0.05, 'alternating noise should not tilt the fit');
  assert.ok(regressionDeviation(noisy, f2) > 0.5);
});

test('regression copes with degenerate input rather than returning NaN', () => {
  for (const pts of [[], [{ x: 1, y: 5 }], [{ x: 2, y: 1 }, { x: 2, y: 9 }]]) {
    const f = linearRegression(pts);
    assert.ok(Number.isFinite(f.slope) && Number.isFinite(f.intercept), JSON.stringify(pts));
  }
});

test("a new object is named as MetaTrader names one: '<TF> <Type> <ID>'", () => {
  // The shape, the timeframe prefix and the 4-to-5-digit id are all MetaTrader's, read off its own
  // screenshots: "M1 Trendline 31757", "M1 Fibo 26637", "M1 Andrews Pitchfork 43325".
  assert.match(nextObjectName('trend', [], 'M1'), /^M1 Trendline \d{4,5}$/);
  assert.match(nextObjectName('trend', [], 'H4'), /^H4 Trendline \d{4,5}$/);
  // MetaTrader abbreviates three of the type tokens, and they are not the menu labels.
  assert.match(nextObjectName('fib', [], 'M1'), /^M1 Fibo \d{4,5}$/);
  assert.match(nextObjectName('channelStdDev', [], 'M1'), /^M1 StdDev Channel \d{4,5}$/);
  assert.match(nextObjectName('pitchfork', [], 'M1'), /^M1 Andrews Pitchfork \d{4,5}$/);
});

test("a name is never reused, which is MQL5's one constraint on it", () => {
  const mk = (name: string): Drawing => ({ id: name, kind: 'trend', name, points: [], color: '#fff' });
  // Draw a few hundred on one chart and every one must be distinct from all the others.
  const drawn: Drawing[] = [];
  for (let i = 0; i < 400; i += 1) drawn.push(mk(nextObjectName('trend', drawn, 'M1')));
  assert.equal(new Set(drawn.map((d) => d.name)).size, 400);
});

test('an object drawn before names were stored falls back to its type', () => {
  const d: Drawing = { id: 'x', kind: 'rectangle', points: [], color: '#fff' };
  assert.equal(objectNameOf(d), 'Rectangle');
  assert.equal(objectNameOf({ ...d, name: 'My box' }), 'My box');
});

test("a level's description shows its price only where MetaTrader's %$ asks for it", () => {
  // "To do it, specify the (%$) symbols in the 'Description' field." Both forms are accepted
  // because MetaQuotes writes the token in parentheses and never shows one in use.
  assert.equal(levelLabel('61.8', 3134.85, 2), '61.8');
  assert.equal(levelLabel('61.8 %$', 3134.85, 2), '61.8 3134.85');
  assert.equal(levelLabel('(%$)', 3134.85, 2), '3134.85');
  assert.equal(levelLabel('%$ and %$', 1.5, 3), '1.500 and 1.500');
});

test("the Levels tab's own levels replace the object's defaults", () => {
  const a: Anchor = { time: 0, price: 100 };
  const b: Anchor = { time: 100, price: 200 };
  assert.equal(fibLines(a, b).length, FIB_LEVELS.length);
  const custom = fibLines(a, b, [{ value: 0.25, text: 'quarter' }]);
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.label, 'quarter');
  // ratio 0 is the second anchor and 1 the first, so 0.25 sits a quarter of the way back to it.
  assert.equal(custom[0]!.price, 175);
  // An empty grid falls back to the defaults rather than drawing nothing.
  assert.equal(fibLines(a, b, []).length, FIB_LEVELS.length);
});

test("a Fibonacci object's defaults are MetaTrader's, and a trendline has none", () => {
  assert.deepEqual(defaultLevelsOf('fib').map((l) => l.value), [...FIB_LEVELS]);
  // MetaQuotes' screenshot of the tab shows the descriptions as percentages: 0.0, 23.6, 38.2 …
  assert.deepEqual(defaultLevelsOf('fib').slice(0, 3).map((l) => l.text), ['0.0', '23.6', '38.2']);
  // Levels belong only to the Fibonacci tools and Andrews' Pitchfork.
  assert.deepEqual(defaultLevelsOf('trend'), []);
  assert.deepEqual(defaultLevelsOf('rectangle'), []);
  assert.equal(defaultLevelsOf('pitchfork').length, 3);
});

test("the Gann objects' scale is a declared price per bar, not the drag", () => {
  const d = (over: Partial<Drawing>): Drawing => ({
    id: 'g', kind: 'gannFan', color: '#fff',
    points: [{ time: 0, price: 100 }, { time: 600, price: 160 }],
    ...over,
  });
  // Unset, the slope comes from the anchors: 60 price over 10 bars of 60s = 6 per bar, and at
  // two decimals a point is 0.01, so 600 points per bar.
  assert.equal(gannUnitPerSecond(d({}), 60, 2), undefined);
  assert.equal(gannPipsPerBar(d({}), 60, 2), 600);
  // Set, it overrides: 4 points per bar at two decimals is 0.04 per 60s.
  assert.ok(Math.abs(gannUnitPerSecond(d({ pipsPerBar: 4 }), 60, 2)! - 0.04 / 60) < 1e-12);
  // Downtrend inclines it downwards, which is all the checkbox does.
  assert.ok(gannUnitPerSecond(d({ pipsPerBar: 4, downtrend: true }), 60, 2)! < 0);
  // And the fan's 1x1 ray then follows that scale rather than the second anchor's price.
  const rays = gannFan(d({}).points[0]!, d({}).points[1]!, 1, gannUnitPerSecond(d({ pipsPerBar: 4 }), 60, 2));
  const oneByOne = rays.find((r) => r.ratio === 1)!;
  assert.ok(Math.abs(oneByOne.line.b.price - (100 + 0.04 * 10)) < 1e-9);
});

test('an object hidden on a period is not drawn on it', () => {
  const d: Drawing = { id: 'x', kind: 'trend', points: [], color: '#fff' };
  // Nothing stored means every period, which is MetaTrader's "All timeframes".
  assert.equal(shownOn(d, 'M1'), true);
  assert.equal(shownOn({ ...d, timeframes: ['H1', 'H4'] }, 'M1'), false);
  assert.equal(shownOn({ ...d, timeframes: ['H1', 'H4'] }, 'H4'), true);
  assert.equal(shownOn({ ...d, timeframes: [] }, 'M1'), false);
});

test("MetaTrader's five line styles map to real dash patterns, and solid to none", () => {
  assert.equal(dashOf(undefined), undefined);
  assert.equal(dashOf('solid'), undefined);
  assert.equal(LINE_STYLES.length, 5);
  assert.deepEqual(LINE_STYLES.map((s) => s.label), ['Solid', 'Dash', 'Dot', 'Dash-dot', 'Dash-dot-dot']);
  for (const s of LINE_STYLES.filter((x) => x.id !== 'solid')) assert.ok(s.dash && s.dash.length > 0);
});

test("a selected object's markers are MetaTrader's: one per anchor, plus a central moving point", () => {
  const mk = (kind: DrawingKind, n: number): Drawing =>
    ({ id: 'h', kind, color: '#fff', points: Array.from({ length: n }, (_, i) => ({ time: i * 60, price: 100 + i })) });
  // A trendline's moving point is the midpoint of its two ends, so three markers in all.
  assert.deepEqual(moveHandleOf(mk('trend', 2)), [0, 1]);
  // Andrews' Pitchfork's is the midpoint of its two teeth, which MetaQuotes calls the second
  // point of the handle: four markers.
  assert.deepEqual(moveHandleOf(mk('pitchfork', 3)), [1, 2]);
  // A Gann Fan has "two points, both on the 1x1 trendline" and no central one.
  assert.equal(moveHandleOf(mk('gannFan', 2)), null);
  assert.equal(moveHandleOf(mk('gannGrid', 2)), null);
  assert.equal(moveHandleOf(mk('gannLine', 2)), null);
  // A one-anchor object is moved by its only marker.
  assert.equal(moveHandleOf(mk('horizontal', 1)), null);
});

test('moving an object shifts every anchor by the same amount, so its shape is kept', () => {
  const d: Drawing = {
    id: 'm', kind: 'pitchfork', color: '#fff',
    points: [{ time: 0, price: 10 }, { time: 60, price: 20 }, { time: 120, price: 5 }],
  };
  const moved = translateDrawing(d, 300, -2.5);
  assert.deepEqual(moved.points, [
    { time: 300, price: 7.5 }, { time: 360, price: 17.5 }, { time: 420, price: 2.5 },
  ]);
  // Same gaps between the anchors before and after, which is what "keeps its shape" means.
  const gaps = (x: Drawing) => x.points.slice(1).map((p, i) => [p.time - x.points[i]!.time, p.price - x.points[i]!.price]);
  assert.deepEqual(gaps(moved), gaps(d));
});
