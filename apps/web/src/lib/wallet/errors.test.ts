import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimErrorNotice, paymentErrorMessage } from './errors.js';

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

/**
 * ── Pay Bill claim refusals (BUGLOG #163 part 3) ──────────────────────────────────────────────────
 * The API sends the code as BOTH the envelope code and the message (`domain()` passes a business
 * error's raw message straight through), so these fixtures are the exact shape the client receives.
 */
test('CODE_ALREADY_CREDITED: says the money is banked, never that the code is wrong', () => {
  const shown = paymentErrorMessage(apiErr('CODE_ALREADY_CREDITED', 'CODE_ALREADY_CREDITED'));
  // The bug: unmapped, TECHNICAL_RE caught the code and the player got the generic "try again in a
  // few minutes" — telling them a payment that HAS been credited had failed.
  assert.doesNotMatch(shown, /try again|verify that code|check it/i);
  assert.match(shown, /already been credited/i);
  assert.match(shown, /balance/i, 'it must send the player to their balance, which is where the money is');
  // It must NOT claim the credit landed on the account that is asking: the guard also fires when the
  // payment credited the account that MADE it, which is not necessarily this one.
  assert.doesNotMatch(shown, /has been added|is in your wallet|we have credited you/i);
  assert.doesNotMatch(shown, /CODE_ALREADY|[{}]/, 'never the raw code');
});

test('CODE_ALREADY_USED still names the other account', () => {
  // This copy used to live in PayBillDeposit.tsx; moving it here must not blur it into "already used".
  assert.match(paymentErrorMessage(apiErr('CODE_ALREADY_USED', 'CODE_ALREADY_USED')), /another account/i);
});

test('PAYBILL_NOT_AVAILABLE tells the player to use another method, not to retry', () => {
  const shown = paymentErrorMessage(apiErr('PAYBILL_NOT_AVAILABLE', 'PAYBILL_NOT_AVAILABLE'));
  assert.match(shown, /another deposit method/i);
  assert.doesNotMatch(shown, /few minutes|PAYBILL_NOT/i, 'retrying can never make a disabled channel work');
});

test('claimErrorNotice: only an already-credited payment is shown in the positive tone', () => {
  assert.equal(claimErrorNotice(apiErr('CODE_ALREADY_CREDITED', 'CODE_ALREADY_CREDITED')).tone, 'ok');
  // Everything else is a real failure and stays red.
  for (const code of ['CODE_ALREADY_USED', 'INVALID_CODE', 'PROVIDER_DISABLED', 'RATE_LIMITED', 'INTERNAL']) {
    assert.equal(claimErrorNotice(apiErr(code, code)).tone, 'error', code);
  }
  assert.equal(claimErrorNotice(new Error('fetch failed')).tone, 'error');
  // Same copy as paymentErrorMessage — the notice adds tone, it does not fork the wording.
  const e = apiErr('INSUFFICIENT_FUNDS', 'x');
  assert.equal(claimErrorNotice(e).text, paymentErrorMessage(e));
});
