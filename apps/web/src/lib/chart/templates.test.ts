import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROPERTIES } from './chartProperties.js';
import { INDICATOR_BY_ID } from './indicatorCatalog.js';
import {
  BUILT_IN_TEMPLATES, DEFAULT_TEMPLATE_NAME, deleteTemplate, findTemplate, listTemplates,
  removableTemplates, resetTemplates, saveTemplate,
} from './templates.js';

/**
 * Templates live in this device's storage, so the module is exercised against a stand-in for it.
 * Everything else here is the rule a template has to keep: a shipped one cannot be lost, and a
 * saved one is the chart it was saved from.
 */
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

beforeEach(() => { store.clear(); resetTemplates(); });

test('the terminal ships four templates, and every one applies something real', () => {
  assert.equal(BUILT_IN_TEMPLATES.length, 4);
  assert.equal(BUILT_IN_TEMPLATES[0]!.name, DEFAULT_TEMPLATE_NAME);
  for (const t of BUILT_IN_TEMPLATES) {
    assert.equal(t.builtIn, true, t.name);
    // Every indicator a seeded template names is one this terminal actually has.
    for (const id of t.indicators) {
      assert.ok(INDICATOR_BY_ID.has(id), `${t.name} names a real indicator (${id})`);
    }
    // None of them forces a period: applying "Oscillator" to an H4 chart gives you the
    // oscillators, not M1.
    assert.equal(t.timeframe, null, t.name);
  }
  // And they are four DIFFERENT charts, not one chart under four names.
  const shapes = BUILT_IN_TEMPLATES.map((t) => `${t.kind}:${[...t.indicators].sort().join(',')}`);
  assert.equal(new Set(shapes).size, 4);
});

test('a saved template is the chart it was saved from', () => {
  assert.equal(saveTemplate({
    name: 'My gold chart',
    kind: 'heikin',
    timeframe: 'H1',
    properties: { ...DEFAULT_PROPERTIES, showGrid: false },
    indicators: ['rsi'],
  }), 'saved');
  const got = findTemplate('My gold chart');
  assert.ok(got);
  assert.equal(got.kind, 'heikin');
  assert.equal(got.timeframe, 'H1');
  assert.equal(got.properties.showGrid, false);
  assert.deepEqual([...got.indicators], ['rsi']);
  assert.equal(got.builtIn, false);
  assert.ok((got.savedAtMs ?? 0) > 0, 'and it remembers when');
});

test('saving twice under one name replaces, rather than growing a second', () => {
  saveTemplate({ name: 'Mine', kind: 'candles', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [] });
  saveTemplate({ name: 'Mine', kind: 'line', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: ['ma'] });
  assert.equal(listTemplates().filter((t) => t.name === 'Mine').length, 1);
  assert.equal(findTemplate('Mine')!.kind, 'line');
});

test('a shipped name is refused, so Default is always there to fall back to', () => {
  assert.equal(saveTemplate({
    name: DEFAULT_TEMPLATE_NAME, kind: 'line', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [],
  }), 'reserved');
  // Untouched.
  assert.equal(findTemplate(DEFAULT_TEMPLATE_NAME)!.kind, 'candles');
  assert.equal(saveTemplate({ name: '   ', kind: 'line', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [] }), 'empty');
  assert.equal(listTemplates().length, BUILT_IN_TEMPLATES.length);
});

test('only a saved template can be removed, and Remove offers only those', () => {
  saveTemplate({ name: 'Mine', kind: 'candles', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [] });
  assert.deepEqual(removableTemplates().map((t) => t.name), ['Mine']);
  deleteTemplate('Mine');
  assert.equal(findTemplate('Mine'), null);
  // Asking to delete a shipped one does nothing at all.
  deleteTemplate(DEFAULT_TEMPLATE_NAME);
  assert.ok(findTemplate(DEFAULT_TEMPLATE_NAME));
  assert.equal(listTemplates().length, BUILT_IN_TEMPLATES.length);
});

test('the shipped templates come first, and a trader s own follow in the order they were saved', () => {
  saveTemplate({ name: 'First', kind: 'candles', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [] });
  saveTemplate({ name: 'Second', kind: 'candles', timeframe: null, properties: DEFAULT_PROPERTIES, indicators: [] });
  const names = listTemplates().map((t) => t.name);
  assert.deepEqual(names.slice(0, 4), BUILT_IN_TEMPLATES.map((t) => t.name));
  assert.deepEqual(names.slice(4), ['First', 'Second']);
});

test('corrupt storage falls back to the shipped four rather than blanking the submenu', () => {
  store.set('pp-chart-templates', '{ not json');
  assert.deepEqual(listTemplates().map((t) => t.name), BUILT_IN_TEMPLATES.map((t) => t.name));
  store.set('pp-chart-templates', JSON.stringify([{ name: '' }, { nope: 1 }]));
  assert.equal(listTemplates().length, BUILT_IN_TEMPLATES.length);
  // A stored entry that shadows a shipped name is dropped, not drawn twice.
  store.set('pp-chart-templates', JSON.stringify([{ name: DEFAULT_TEMPLATE_NAME, kind: 'line' }]));
  assert.equal(listTemplates().filter((t) => t.name === DEFAULT_TEMPLATE_NAME).length, 1);
  assert.equal(findTemplate(DEFAULT_TEMPLATE_NAME)!.kind, 'candles');
});
