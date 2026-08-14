import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessageFor, sourceLabel } from './format.js';

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
