import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessageFor, sourceLabel, shouldResetSupportChat, subjectFromToken } from './format.js';

test('errorMessageFor: 429 is a distinct, calm rate-limit message', () => {
  assert.match(errorMessageFor(429), /too fast/i);
  assert.match(errorMessageFor(500), /something went wrong/i);
  assert.match(errorMessageFor(404), /something went wrong/i);
});

test('errorMessageFor: never contains an em dash', () => {
  for (const s of [429, 500, 400, 401]) assert.ok(!/[\u2014\u2013]/.test(errorMessageFor(s)));
});

test('sourceLabel: strips numeric prefix, extension, and separators', () => {
  assert.equal(sourceLabel('docs/08-payments-mpesa.md'), 'payments mpesa');
  assert.equal(sourceLabel('docs/20-multitenant-architecture.md'), 'multitenant architecture');
  assert.equal(sourceLabel('kb://brandb/secret'), 'secret');
  assert.equal(sourceLabel('README.md'), 'README');
});

// ── Issue 1 / F-48: shared-device privacy ─────────────────────────────────────────────────────
test('shouldResetSupportChat: a signed-in conversation never survives a change of person', () => {
  assert.equal(shouldResetSupportChat('u1', 'c1', 'u2'), true, 'another account signs in');
  assert.equal(shouldResetSupportChat('u1', 'c1', null), true, 'owner signs out');
  assert.equal(shouldResetSupportChat('u1', 'c1', 'u1'), false, 'same account');
  assert.equal(shouldResetSupportChat(null, 'c1', 'u1'), false, 'anonymous visitor signs in: keep');
  assert.equal(shouldResetSupportChat(null, 'c1', null), false);
  assert.equal(shouldResetSupportChat('u1', null, 'u2'), false, 'nothing stored');
});

test('subjectFromToken: reads sub, tolerates garbage', () => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(subjectFromToken(`h.${enc({ sub: 'user-9', role: 'player' })}.s`), 'user-9');
  assert.equal(subjectFromToken(`h.${enc({ role: 'player' })}.s`), null);
  assert.equal(subjectFromToken('not-a-jwt'), null);
  assert.equal(subjectFromToken('a.%%%.b'), null);
  assert.equal(subjectFromToken(null), null);
});
