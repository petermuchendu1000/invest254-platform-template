import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveDuration } from './duration.js';

/**
 * The clamp that keeps a remembered contract term from outliving the configuration it was chosen
 * in. Same rule the volume store documents, and the reason the chart menu's pending-order row can
 * state a term at all: whatever it states has to be a term the brand still offers.
 */

const OFFERED = [10, 30, 60, 120] as const;

test('a stored term the brand still offers is the term used', () => {
  assert.equal(effectiveDuration(60, OFFERED, 10), 60);
  assert.equal(effectiveDuration(10, OFFERED, 30), 10);
});

test('nothing stored yet falls back to the brand default, not to the first option', () => {
  // `null` is "not chosen", which is not zero and not "the smallest": a brand whose default is 30
  // must open on 30 even though 10 is offered.
  assert.equal(effectiveDuration(null, OFFERED, 30), 30);
});

test('a term the brand has dropped falls back rather than placing an order on it', () => {
  // The figure is remembered across sessions, so a brand that stops offering 300s must not have
  // orders placed on 300s by a device that remembers it.
  assert.equal(effectiveDuration(300, OFFERED, 10), 10);
  assert.equal(effectiveDuration(0, OFFERED, 10), 10);
  assert.equal(effectiveDuration(Number.NaN, OFFERED, 10), 10);
});

test('the brand default is always available, even when it is not one of the standard four', () => {
  // `durations` is built as the union of the standard set and the brand's own, so a brand default
  // of 45 is offered; this checks the clamp agrees rather than rejecting the brand's own figure.
  assert.equal(effectiveDuration(45, [10, 30, 45, 60, 120], 45), 45);
});
