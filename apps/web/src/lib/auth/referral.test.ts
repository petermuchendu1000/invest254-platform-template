import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referralFromSearch } from './referral';

test('referralFromSearch: extracts + uppercases ?ref', () => {
  assert.equal(referralFromSearch('?ref=egvta3ww'), 'EGVTA3WW');
  assert.equal(referralFromSearch('ref=EGVTA3WW'), 'EGVTA3WW');
});

test('referralFromSearch: accepts ?r and ?code with precedence ref > r > code', () => {
  assert.equal(referralFromSearch('?r=abcd1234'), 'ABCD1234');
  assert.equal(referralFromSearch('?code=zzzz9999'), 'ZZZZ9999');
  assert.equal(referralFromSearch('?ref=aaaa1111&r=bbbb2222&code=cccc3333'), 'AAAA1111');
});

test('referralFromSearch: rejects invalid/absent codes', () => {
  assert.equal(referralFromSearch(''), null);
  assert.equal(referralFromSearch('?ref='), null);
  assert.equal(referralFromSearch('?ref=ab'), null);            // too short
  assert.equal(referralFromSearch('?ref=has space'), null);      // invalid char
  assert.equal(referralFromSearch('?ref=drop;table'), null);     // injection-ish
  assert.equal(referralFromSearch('?other=EGVTA3WW'), null);     // unrelated param
});

test('referralFromSearch: tolerates extra params + full URLs search', () => {
  assert.equal(referralFromSearch('?utm_source=x&ref=EGVTA3WW&y=1'), 'EGVTA3WW');
});
