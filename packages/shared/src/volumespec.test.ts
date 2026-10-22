import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYMBOLS, SYMBOL_GROUPS, conventionalVolume, volumeSpecOf, volumeDigitsOf, effectiveVolume,
  DEFAULT_SYMBOL,
} from './symbols.js';
import { LOT_STAKE_CENTS } from './account.js';

test('every symbol in the catalogue has a volume spec, and it is its group’s', () => {
  for (const s of SYMBOLS) {
    const spec = volumeSpecOf(s.symbol);
    assert.deepEqual(spec, conventionalVolume(s.group), s.symbol);
  }
});

test('every group’s spec is usable: a positive step that divides its range', () => {
  for (const g of SYMBOL_GROUPS) {
    const { min, max, step } = conventionalVolume(g);
    assert.ok(step > 0, g);
    assert.ok(min >= step - 1e-9, `${g}: a minimum below one step cannot be stepped to`);
    assert.ok(max > min, g);
    // The minimum has to sit ON the step grid, or the first increment lands off it forever.
    assert.ok(Math.abs(min / step - Math.round(min / step)) < 1e-9, `${g}: ${min} is off its ${step} grid`);
  }
});

test('the catalogue does NOT offer one range for the whole book, which is the bug this fixes', () => {
  const specs = new Set(SYMBOL_GROUPS.map((g) => JSON.stringify(conventionalVolume(g))));
  assert.ok(specs.size >= 4, `only ${specs.size} distinct specs: that is close to one setting again`);
});

test('an index steps in tenths and everything else in hundredths', () => {
  // A hundredth of an index lot is granularity nobody trades in, which is why brokers quote it
  // this way. It is also the one place the volume DIGITS change.
  assert.equal(conventionalVolume('Indices').step, 0.1);
  assert.equal(volumeDigitsOf(conventionalVolume('Indices')), 1);
  for (const g of SYMBOL_GROUPS.filter((x) => x !== 'Indices')) {
    assert.equal(conventionalVolume(g).step, 0.01, g);
    assert.equal(volumeDigitsOf(conventionalVolume(g)), 2, g);
  }
});

test('liquidity orders the ceilings: majors highest, crypto lowest', () => {
  const max = (g: Parameters<typeof conventionalVolume>[0]) => conventionalVolume(g).max;
  assert.ok(max('Forex\\Majors') > max('Forex\\Minors'));
  assert.ok(max('Forex\\Minors') > max('Forex\\Exotics'));
  assert.ok(max('Crypto') < max('Forex\\Majors'));
  assert.ok(max('Crypto') <= max('Forex\\Exotics'));
});

test('the brand’s money limits win, because they are what the engine enforces', () => {
  const gold = volumeSpecOf('XAUUSD');          // 0.01 .. 50 in hundredths
  // A brand whose minimum stake is KES 250 is 0.025 lots, ABOVE gold's conventional 0.01: the
  // ticket must offer the brand's, or it shows a volume the engine refuses.
  const brandMinLots = 25_000 / LOT_STAKE_CENTS;
  const eff = effectiveVolume(gold, brandMinLots, 1);
  assert.equal(eff.min, brandMinLots);
  assert.equal(eff.max, 1);
  // The step stays the symbol's: granularity is not a limit.
  assert.equal(eff.step, gold.step);
});

test('a brand with no ceiling leaves the symbol’s own standing', () => {
  const eff = effectiveVolume(volumeSpecOf('EURUSD'), 0.01, null);
  assert.equal(eff.max, conventionalVolume('Forex\\Majors').max);
});

test('a brand minimum above the symbol’s ceiling leaves one tradable volume, not an inverted range', () => {
  const eff = effectiveVolume(volumeSpecOf('BTCUSD'), 500, 600);
  assert.equal(eff.min, 500);
  assert.equal(eff.max, 500);
  assert.ok(eff.max >= eff.min, 'an inverted range cannot be clamped into');
});

test('the default symbol resolves, so the shipped brand is not on a fallback', () => {
  const d = SYMBOLS.find((s) => s.symbol === DEFAULT_SYMBOL);
  assert.ok(d, DEFAULT_SYMBOL);
  assert.deepEqual(volumeSpecOf(DEFAULT_SYMBOL), conventionalVolume(d.group));
});

test('an unknown symbol falls back rather than throwing, since the chart can be on anything', () => {
  assert.deepEqual(volumeSpecOf('NOTASYMBOL'), conventionalVolume('Forex\\Majors'));
});
