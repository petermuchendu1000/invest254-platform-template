import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultMpesaEndpoints, DEFAULT_MPESA_ENV } from './mpesaDefaults.js';

test('derives Daraja endpoints from the API base url', () => {
  const d = defaultMpesaEndpoints('https://invest254-api.fly.dev/api/v1');
  assert.equal(d.stkCallbackUrl, 'https://invest254-api.fly.dev/api/v1/deposits/mpesa/callback');
  assert.equal(d.b2cResultUrl, 'https://invest254-api.fly.dev/api/v1/withdrawals/mpesa/result');
  assert.equal(d.b2cTimeoutUrl, 'https://invest254-api.fly.dev/api/v1/withdrawals/mpesa/result');
});

test('tolerates a trailing slash on the base url', () => {
  const d = defaultMpesaEndpoints('https://x/api/v1/');
  assert.equal(d.stkCallbackUrl, 'https://x/api/v1/deposits/mpesa/callback');
});

test('empty base yields safe relative paths without throwing', () => {
  const d = defaultMpesaEndpoints('');
  assert.equal(d.stkCallbackUrl, '/deposits/mpesa/callback');
});

test('production is the default environment', () => {
  assert.equal(DEFAULT_MPESA_ENV, 'production');
});
