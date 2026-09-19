import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentErrorMessage } from './errors.js';

// ApiError-shaped plain objects (structural — no @/ imports so this runs under node --test).
const apiErr = (code: string, message: string) => ({ code, message, name: 'ApiError' });

test('paymentErrorMessage: known codes map to friendly copy', () => {
  assert.match(paymentErrorMessage(apiErr('PROVIDER_ERROR', 'x')), /try again|another payment method/i);
  assert.match(paymentErrorMessage(apiErr('PROVIDER_UNAVAILABLE', 'x')), /temporarily unavailable/i);
  assert.match(paymentErrorMessage(apiErr('INSUFFICIENT_FUNDS', 'x')), /insufficient balance/i);
});

test('paymentErrorMessage: NEVER leaks a raw technical string to a client (the reported bug)', () => {
  const raw = apiErr('INTERNAL',
    'PAYHERO_INITIATE_REJECTED_400:{"error_code":"BAD_REQUEST","error_message":"merchant has insufficient balance","status_code":400}');
  const shown = paymentErrorMessage(raw);
  assert.doesNotMatch(shown, /PAYHERO|REJECTED|insufficient balance|error_code|status_code|[{}]/);
  assert.match(shown, /try again/i);
  assert.doesNotMatch(paymentErrorMessage(apiErr('INTERNAL', 'PAYHERO_NOT_CONFIGURED:channel_id')), /PAYHERO|NOT_CONFIGURED/);
});

test('paymentErrorMessage: a clean human backend message is preserved', () => {
  assert.equal(paymentErrorMessage(apiErr('SOME_HINT', 'Enter a phone that starts with 07.')), 'Enter a phone that starts with 07.');
});

test('paymentErrorMessage: non-ApiError -> network copy', () => {
  assert.match(paymentErrorMessage(new Error('fetch failed')), /network|connection/i);
});
