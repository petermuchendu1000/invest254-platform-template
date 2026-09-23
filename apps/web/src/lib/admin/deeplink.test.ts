import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWithdrawalDeepLink } from './deeplink.js';

test('UI-4: a deep link only selects + states intent; it never carries an executable action', () => {
  const d = parseWithdrawalDeepLink('?highlight=4f1c-99&do=reject');
  assert.deepEqual(d, { highlight: '4f1c-99', intent: 'reject', cleanedSearch: '?highlight=4f1c-99' });
  assert.equal(parseWithdrawalDeepLink('?highlight=abc&do=approve').intent, 'approve');
});

test('UI-4: unknown actions, missing/garbage tx ids are ignored', () => {
  assert.equal(parseWithdrawalDeepLink('?highlight=abc&do=delete').intent, null);
  assert.deepEqual(parseWithdrawalDeepLink('?do=reject'), { highlight: null, intent: null, cleanedSearch: '' });
  assert.equal(parseWithdrawalDeepLink('?highlight=%3Cscript%3E&do=reject').highlight, null);
  assert.equal(parseWithdrawalDeepLink('?highlight=abc&status=pending&do=reject').cleanedSearch, '?highlight=abc&status=pending');
});
