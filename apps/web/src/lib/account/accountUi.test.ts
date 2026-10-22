import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kycLabelSuffix } from './kycLabel.js';

/**
 * The menu entry that leads to the verification dialog has to say what state the account is in.
 *
 * On a phone the drawer is the only route to that dialog, and its entry read a plain
 * "Verify Identity" whatever had already been sent — so a trader whose documents were under review
 * saw an invitation to send them again, which is exactly what they did.
 */

test('a state already sent is named, so the entry does not read as an invitation', () => {
  assert.equal(kycLabelSuffix('pending'), ' · in review');
  assert.equal(kycLabelSuffix('approved'), ' · verified');
  assert.equal(kycLabelSuffix('rejected'), ' · not approved');
});

test('nothing sent, and nothing known, both add nothing', () => {
  // `undefined` is the status not having loaded. It must read the same as "never submitted" HERE,
  // because a menu label cannot ask a question; the dialog behind it is where the distinction is
  // made, and it refuses to show the form until it knows (AccountDialogs: st === 'unknown').
  assert.equal(kycLabelSuffix('none'), '');
  assert.equal(kycLabelSuffix(undefined), '');
});

test('every suffix starts with the same separator, so the two menus cannot drift apart', () => {
  for (const s of ['pending', 'approved', 'rejected'] as const) {
    assert.match(kycLabelSuffix(s), /^ · [a-z]/, s);
  }
});
