import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartOverride } from './chartOverride.js';

/**
 * The rule that stops the terminal refusing to trade the symbol it is already drawing.
 *
 * The stored chart symbol and "the chart is on another instrument" are different questions. Every
 * writer of the stored value compares the clicked symbol against a `defaultSymbol` it has to
 * discover asynchronously, and before that answer lands the comparison is against `null`, so the
 * brand's OWN symbol gets stored. Deriving the refusal from `stored !== null` then produced
 * `Trade disabled for XAUUSD.` beside a button offering to `Chart XAUUSD` — on a chart already
 * drawing XAUUSD. Clicking the button stored the same thing again, and the value is persisted, so
 * the state survived every reload.
 */

test('the brand\'s own symbol is never "another instrument", however it came to be stored', () => {
  assert.equal(chartOverride('XAUUSD', 'XAUUSD'), null);
  assert.equal(chartOverride(null, 'XAUUSD'), null);
});

test('a genuinely different symbol is reported as one', () => {
  assert.equal(chartOverride('EURUSD', 'XAUUSD'), 'EURUSD');
});

test('before the settled symbol is known, nothing can be said to differ from it', () => {
  // Null settled means the engine has not answered yet. Reporting an override here is what let a
  // first-paint click decide the whole session was off-instrument.
  assert.equal(chartOverride('EURUSD', null), null);
  assert.equal(chartOverride('XAUUSD', null), null);
  assert.equal(chartOverride(null, null), null);
});

test('it is a pure comparison: no trimming, no case folding, no aliasing', () => {
  // The engine's symbol names are exact, and quietly matching `xauusd` to `XAUUSD` here would hide
  // a real mismatch between what the client stored and what the brand settles.
  assert.equal(chartOverride('xauusd', 'XAUUSD'), 'xauusd');
  assert.equal(chartOverride(' XAUUSD', 'XAUUSD'), ' XAUUSD');
});
