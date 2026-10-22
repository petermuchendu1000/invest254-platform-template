import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInFailure } from './signInError.js';

/*
 * The symptom these tests exist for: a console screenshot showing "Sign-in failed. Please try
 * again." under a correctly-entered authenticator code. The form had one sentence for every cause
 * it did not have a branch for, so the screenshot could not say whether the API had 500'd, throttled
 * the IP, never been reached, or accepted the sign-in and then refused the fresh token. Each case
 * below is one of those, and the assertion is that it no longer reads like the others.
 */

const apiErr = (code: string, status: number) => ({ code, status, message: 'x' });

test('a correct code that meets a server error does not read as a bad code', () => {
  const f = signInFailure(apiErr('DB_ERROR', 500));
  assert.match(f.message, /server failed/i);
  assert.match(f.message, /not the problem/i);     // the operator must stop retyping the code
  assert.equal(f.detail, 'DB_ERROR · HTTP 500');   // the code to search the API log for
});

test('an unmapped status is still named, so a screenshot is diagnosable', () => {
  const f = signInFailure(apiErr('WAT', 418));
  assert.equal(f.message, 'Sign-in failed. Please try again.');
  assert.equal(f.detail, 'WAT · HTTP 418');
});

test('the throttle says how to clear it — by both code and bare status', () => {
  for (const f of [signInFailure(apiErr('RATE_LIMITED', 429)), signInFailure(apiErr('HTTP_429', 429))]) {
    assert.match(f.message, /wait a minute/i);
    assert.ok(f.detail, 'the operator still gets the status');
  }
});

test('an unreachable API is not reported as a failed sign-in', () => {
  // `fetch` rejects with a TypeError: no code, no status, nothing was ever refused.
  const f = signInFailure(new TypeError('Failed to fetch'));
  assert.match(f.message, /could not reach the server/i);
  assert.equal(f.detail, 'no response from the API');
});

test('a token refused right after login says the sign-in itself worked', () => {
  for (const code of ['AUTH_INVALID', 'AUTH_REQUIRED', 'SESSION_IDLE']) {
    const f = signInFailure(apiErr(code, 401));
    assert.match(f.message, /signed in/i, `${code} must not read as a credential failure`);
    assert.equal(f.detail, `${code} · HTTP 401`);
  }
});

test('the three expected credential outcomes stay plain, with no code shown', () => {
  for (const code of ['MFA_REQUIRED', 'MFA_INVALID', 'INVALID_CREDENTIALS']) {
    assert.equal(signInFailure(apiErr(code, 401)).detail, null, `${code} needs no technical detail`);
  }
});

test('MFA_INVALID speaks about whichever factor was actually submitted', () => {
  assert.match(signInFailure(apiErr('MFA_INVALID', 401), { usingRecovery: true }).message, /recovery code/i);
  // Single-use codes (0196) are the one surprise worth pre-empting: the code WAS right, just spent.
  assert.match(signInFailure(apiErr('MFA_INVALID', 401)).message, /works once/i);
});

test('MFA_REQUIRED names the field in front of the operator', () => {
  assert.match(signInFailure(apiErr('MFA_REQUIRED', 401)).message, /6-digit/);
  assert.match(signInFailure(apiErr('MFA_REQUIRED', 401), { usingRecovery: true }).message, /recovery code/i);
});

test('a status gate explains that the account, not the credential, is the blocker', () => {
  assert.match(signInFailure(apiErr('ACCOUNT_SUSPENDED', 403)).message, /suspended/i);
  assert.match(signInFailure(apiErr('ACCOUNT_BANNED', 403)).message, /banned/i);
});
