import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECTS, OBJECT_GROUPS, OBJECT_GROUP_LABELS, MT5_OBJECT_COUNT, DRAWABLE_OBJECTS,
  anchorFields, hasFill, hasGannAngle, hasGannScale, hasLevels, objectOf, objectToken,
  objectTypeName,
} from './objects.js';

/**
 * MetaTrader's Insert > Objects tree, written down. Pinned BY NAME, because a count passes just as
 * happily with the wrong forty-four.
 *
 * Source: https://www.metatrader5.com/en/terminal/help/charts_analysis/objects and the per-category
 * pages beneath it, cross-checked against ENUM_OBJECT.
 */
const MT5 = {
  Lines: ['Horizontal Line', 'Vertical Line', 'Trendline', 'Trendline by Angle', 'Cycle Lines', 'Arrowed Line'],
  Channels: ['Equidistant Channel', 'Standard Deviation Channel', 'Regression Channel', "Andrews' Pitchfork"],
  Gann: ['Gann Line', 'Gann Fan', 'Gann Grid'],
  Fibonacci: ['Fibonacci Retracement', 'Fibonacci Time Zones', 'Fibonacci Fan', 'Fibonacci Arcs', 'Fibonacci Channel', 'Fibonacci Expansion'],
  Elliott: ['Impulse Wave', 'Corrective Wave'],
  Shapes: ['Rectangle', 'Triangle', 'Ellipse'],
  Arrows: [
    'Thumbs Up', 'Thumbs Down', 'Up Arrow', 'Down Arrow', 'Stop Sign', 'Check Sign',
    'Left Price Label', 'Right Price Label', 'Buy Sign', 'Sell Sign', 'Arrow',
  ],
  Graphical: ['Text', 'Text Label', 'Button', 'Graph', 'Bitmap', 'Bitmap Label', 'Edit', 'Event', 'Rectangle Label'],
} as const;

test('the tree carries all 44 of MetaTrader\'s analytical objects', () => {
  assert.equal(OBJECTS.length, MT5_OBJECT_COUNT);
  assert.equal(Object.values(MT5).flat().length, MT5_OBJECT_COUNT);
});

test('the eight group names are MetaTrader\'s, in MetaTrader\'s menu order', () => {
  assert.deepEqual(OBJECT_GROUPS.map((g) => g.label), Object.keys(MT5));
  assert.deepEqual(Object.values(OBJECT_GROUP_LABELS).slice().sort(), Object.keys(MT5).slice().sort());
});

test('every group holds exactly the objects MetaTrader puts in it, in its order', () => {
  for (const g of OBJECT_GROUPS) {
    assert.deepEqual(g.items.map((o) => o.name), MT5[g.label as keyof typeof MT5], `group ${g.label}`);
  }
});

test('Text and Text Label are inside Graphical, not a branch of their own', () => {
  const graphical = OBJECT_GROUPS.find((g) => g.group === 'graphical')!;
  assert.ok(graphical.items.some((o) => o.name === 'Text'));
  assert.ok(graphical.items.some((o) => o.name === 'Text Label'));
});

test('exactly the seven Expert Advisor objects are unavailable, and each says why', () => {
  const blocked = OBJECTS.filter((o) => o.unavailable).map((o) => o.name);
  assert.deepEqual(blocked, ['Button', 'Graph', 'Bitmap', 'Bitmap Label', 'Edit', 'Event', 'Rectangle Label']);
  for (const o of OBJECTS) {
    if (o.unavailable) assert.match(o.unavailable, /Expert Advisor/, `${o.name} must say why`);
  }
});

test('an unavailable object has no drawing kind, so it can never be selected as a tool', () => {
  for (const o of OBJECTS) {
    if (o.unavailable) assert.equal(o.kind, null, `${o.name} must not be drawable`);
    else assert.ok(o.kind, `${o.name} must be drawable`);
  }
  assert.equal(DRAWABLE_OBJECTS.length, MT5_OBJECT_COUNT - 7);
});

test('drawing kinds are unique: the chart keys every object off its kind', () => {
  const kinds = DRAWABLE_OBJECTS.map((o) => o.kind);
  assert.equal(new Set(kinds).size, kinds.length);
});

test('every drawable object needs at least one anchor, and no more than six', () => {
  for (const o of DRAWABLE_OBJECTS) {
    assert.ok(o.anchors >= 1 && o.anchors <= 6, `${o.name} wants ${o.anchors} anchors`);
  }
});

test("an object is named after its type, the way MetaTrader's Objects List prints it", () => {
  assert.equal(objectTypeName('trend'), 'Trendline');
  assert.equal(objectTypeName('gannFan'), 'Gann Fan');
  assert.equal(objectTypeName('pitchfork'), "Andrews' Pitchfork");
  assert.equal(objectTypeName('fib'), 'Fibonacci Retracement');
  // The ruler is ours: MetaTrader measures with a crosshair drag, not an Insert object.
  assert.equal(objectTypeName('measure'), 'Measure');
});

test('only Text and Text Label carry default text, because only they draw it', () => {
  const withText = OBJECTS.filter((o) => o.defaultText !== undefined).map((o) => o.name);
  assert.deepEqual(withText, ['Text', 'Text Label']);
});

test('every drawable object is reachable by kind', () => {
  for (const o of DRAWABLE_OBJECTS) assert.equal(objectOf(o.kind as string)?.name, o.name);
  assert.equal(objectOf('measure'), undefined);
});

test("the Levels tab belongs only to the Fibonacci tools and Andrews' Pitchfork", () => {
  // MetaQuotes states it outright, and its screenshots of a Trendline, Horizontal Line, Rectangle,
  // Gann Line and Gann Fan all show three tabs.
  const levelled = DRAWABLE_OBJECTS.filter((o) => hasLevels(o.kind as string)).map((o) => o.name);
  assert.deepEqual(levelled, [
    // Menu order, so the pitchfork comes first: it lives in Channels, ahead of Fibonacci.
    "Andrews' Pitchfork",
    'Fibonacci Retracement', 'Fibonacci Time Zones', 'Fibonacci Fan', 'Fibonacci Arcs',
    'Fibonacci Channel', 'Fibonacci Expansion',
  ]);
  for (const kind of ['trend', 'horizontal', 'rectangle', 'gannLine', 'gannFan', 'channelStdDev']) {
    assert.equal(hasLevels(kind), false, kind);
  }
});

test("the Parameters tab offers only the coordinates the object actually has", () => {
  // A Horizontal Line's tab holds one Value and no Date, read off MetaQuotes' screenshot.
  assert.deepEqual(anchorFields('horizontal', 0), { date: false, value: true });
  // A Vertical Line is its mirror.
  assert.deepEqual(anchorFields('vertical', 0), { date: true, value: false });
  // A Gann object's second anchor is a Date with no paired Value, which the screenshots show.
  assert.deepEqual(anchorFields('gannFan', 0), { date: true, value: true });
  assert.deepEqual(anchorFields('gannFan', 1), { date: true, value: false });
  // Everything else is an ordinary Date/Value pair.
  assert.deepEqual(anchorFields('trend', 1), { date: true, value: true });
});

test("Fill belongs to the closed shapes, and the Gann fields to the Gann objects", () => {
  for (const kind of ['rectangle', 'triangle', 'ellipse']) assert.equal(hasFill(kind), true, kind);
  for (const kind of ['trend', 'fib', 'gannFan']) assert.equal(hasFill(kind), false, kind);
  // Pips per bar is on all three Gann objects; Gann angle only on the Line.
  for (const kind of ['gannLine', 'gannFan', 'gannGrid']) assert.equal(hasGannScale(kind), true, kind);
  assert.equal(hasGannAngle('gannLine'), true);
  assert.equal(hasGannAngle('gannFan'), false);
});

test("MetaTrader abbreviates three type tokens, and only those three", () => {
  // Read off its own Objects List and object-name screenshots.
  assert.equal(objectToken('fib'), 'Fibo');
  assert.equal(objectToken('channelStdDev'), 'StdDev Channel');
  assert.equal(objectToken('pitchfork'), 'Andrews Pitchfork');
  const abbreviated = OBJECTS.filter((o) => o.token !== undefined).map((o) => o.name);
  assert.deepEqual(abbreviated, [
    'Standard Deviation Channel', "Andrews' Pitchfork", 'Fibonacci Retracement',
  ]);
  // Everything else keeps its menu label.
  assert.equal(objectToken('trend'), 'Trendline');
  assert.equal(objectToken('gannFan'), 'Gann Fan');
});
