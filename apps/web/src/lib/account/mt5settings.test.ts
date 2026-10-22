import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutRows, kycSub, kycTone } from './mt5settings.js';

test('About: a signed-in account sees every row', () => {
  assert.deepEqual(aboutRows(false).map((r) => r.id), ['terms', 'privacy', 'responsible', 'licence']);
});

test('About: a marketer screen drops every gambling row, and keeps the rest', () => {
  const ids = aboutRows(true).map((r) => r.id);
  assert.deepEqual(ids, ['terms', 'privacy']);
  // Stated as the property rather than the list, so a row added later is covered too.
  assert.ok(aboutRows(true).every((r) => !r.gambling));
  assert.ok(aboutRows(true, 'trading').every((r) => !r.gambling));
});

test('About: a broker links to its risk disclosure, a gaming brand to its own page', () => {
  const trading = aboutRows(false, 'trading').find((r) => r.id === 'responsible')!;
  assert.equal(trading.label, 'Risk disclosure');
  assert.equal(trading.href, '/legal#risk');
  const gaming = aboutRows(false, 'gaming').find((r) => r.id === 'responsible')!;
  assert.equal(gaming.label, 'Responsible gaming');
  assert.equal(gaming.href, '/legal#responsible-gaming');
  // Neither reaches the other's page, which is the whole reason the anchor comes from one module.
  assert.notEqual(trading.href, gaming.href);
});

test('About: every row points somewhere and says what it is', () => {
  for (const reg of ['trading', 'gaming'] as const) {
    for (const r of aboutRows(false, reg)) {
      assert.ok(r.href.startsWith('/'), `${reg} ${r.id} href`);
      assert.ok(r.label.length > 0 && r.sub.length > 0, `${reg} ${r.id} text`);
    }
  }
});

test('Identity: each KYC status reads as a state, never as a raw code', () => {
  assert.equal(kycSub('approved'), 'Verified');
  assert.equal(kycSub('pending'), 'In review');
  assert.equal(kycSub('rejected'), 'Not approved: try again');
  assert.equal(kycSub('none'), 'Not verified');
  assert.equal(kycSub(null), 'Not verified', 'asked, and there is no record: that IS not verified');
});

test('Identity: a status that has not arrived is not an answer', () => {
  /**
   * `undefined` used to fall through to "Not verified", which told a trader who HAD sent their
   * documents that they had not -- while the request was still in flight, before the token had
   * rehydrated, or after the call failed. It is the same collapse the verification dialog was fixed
   * for, left on the row that opens it, and it is the one wrong answer this row can give: the
   * others are recoverable, that one makes a trader submit everything a second time.
   */
  assert.equal(kycSub(undefined), 'Checking…');
  assert.notEqual(kycSub(undefined), kycSub(null), 'not-yet-known and known-to-be-none differ');
  assert.equal(kycTone(undefined), 'neutral', 'and it is not coloured as a verdict');
});

test('Identity: only approved is green and only rejected is red', () => {
  assert.equal(kycTone('approved'), 'ok');
  assert.equal(kycTone('rejected'), 'bad');
  for (const s of ['pending', 'none', null, undefined]) assert.equal(kycTone(s), 'neutral', String(s));
});
