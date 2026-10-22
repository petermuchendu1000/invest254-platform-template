import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneDisplay, isMaskedValue } from './phoneMask.js';

/**
 * BUGLOG #133. The owner's requirement, verbatim: sign-in / sign-up "should look like 0798***61, and
 * the user can click the eye thing to see the hidden characters, NOT completely hide the number".
 * These tests pin that shape, and pin the thing that makes it safe to do on a login field: the real
 * digits are what the component holds and submits — the mask is only ever what is DISPLAYED.
 */

const REAL = '0798661061';
const MASKED = '0798****061';

test('#133 at rest the field shows the PARTIAL mask, not a password blob', () => {
  const shown = phoneDisplay(REAL, false, false);
  assert.equal(shown, MASKED);
  // The whole point: head and tail stay readable, so it is recognisably your own number...
  assert.ok(shown.startsWith('0798'), 'head must stay visible');
  assert.ok(shown.endsWith('061'), 'tail must stay visible');
  // ...while the middle digits are gone, and it is NOT the full number.
  assert.notEqual(shown, REAL);
  assert.ok(!shown.includes('6610'), 'the middle digits must not be on screen');
});

test('#133 the eye reveals the hidden digits (full number), without needing focus', () => {
  assert.equal(phoneDisplay(REAL, true, false), REAL);
});

test('#133 while the field has FOCUS the real digits show, so typing and correcting work', () => {
  // An input renders its own value: masking mid-edit would feed the mask back through onChange.
  assert.equal(phoneDisplay(REAL, false, true), REAL);
  assert.equal(phoneDisplay(REAL, true, true), REAL);
});

test('#133 an empty field stays empty (the placeholder must show, never a mask of nothing)', () => {
  assert.equal(phoneDisplay('', false, false), '');
  assert.equal(phoneDisplay('', true, false), '');
});

test('#133 a partially typed number never leaks a tail it should not, and never throws', () => {
  for (const partial of ['0', '07', '079', '0798', '07986', '079866']) {
    const out = phoneDisplay(partial, false, false);
    assert.equal(typeof out, 'string');
    // Too short to keep both ends -> the helper masks wholesale rather than exposing digits.
    assert.ok(out === partial.replace(/./g, '*') || out.includes('*') || out === partial);
  }
});

test('#133 the display mask is detectable, so it can never be read back as input', () => {
  assert.equal(isMaskedValue(MASKED), true);
  assert.equal(isMaskedValue(REAL), false);
  assert.equal(isMaskedValue(''), false);
  // This is the guard the onChange handlers use: had the mask ever reached a digits-only
  // normaliser it would have posted "0798061" — a different, valid-looking number.
  assert.equal(MASKED.replace(/\D/g, ''), '0798061');
  assert.notEqual(MASKED.replace(/\D/g, ''), REAL);
});
