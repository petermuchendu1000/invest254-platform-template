import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStepUpExemptPath,
  registerSessionIdleHandler,
  registerStepUpHandler,
  reportSessionIdle,
  requestStepUp,
} from './stepUp.js';

/*
 * The broker is the one place a STEP_UP_REQUIRED 403 can turn into a prompt, so its two failure
 * modes are both console-freezing and neither is visible in a type check: a challenge raised for a
 * call that is itself trying to satisfy a challenge (deadlock), and one modal per concurrent 403.
 */

test('0196: the calls that satisfy or end a challenge can never raise one', () => {
  for (const p of ['/auth/step-up', '/auth/logout', '/auth/refresh', '/auth/mfa/enroll', '/auth/mfa/confirm', '/auth/security-questions']) {
    assert.equal(isStepUpExemptPath(p), true, p);
  }
  assert.equal(isStepUpExemptPath('/auth/step-up?x=1'), true, 'a query string does not change the path');
  assert.equal(isStepUpExemptPath('/admin/users/u1/wallet'), false);
  assert.equal(isStepUpExemptPath('/auth/mfa/disable'), false, 'removing your own 2FA is NOT exempt server-side');
});

test('0196: with nothing mounted to ask with, the caller keeps its own error instead of hanging', async () => {
  assert.equal(await requestStepUp('t1'), false);
});

test('0196: concurrent 403s on one session share ONE prompt, and one proof settles them all', async () => {
  let prompts = 0;
  let settle: ((proven: boolean) => void) | null = null;
  const unregister = registerStepUpHandler(() => {
    prompts += 1;
    return new Promise<boolean>((resolve) => { settle = resolve; });
  });
  try {
    const a = requestStepUp('t1');
    const b = requestStepUp('t1');
    assert.equal(prompts, 1, 'a second 403 joins the pending challenge rather than stacking a modal');
    settle!(true);
    assert.deepEqual([await a, await b], [true, true]);

    // The challenge is no longer pending, so the NEXT refusal (a later action, after the window
    // lapses) can raise a fresh one — otherwise the first proof would be the last prompt forever.
    const c = requestStepUp('t1');
    assert.equal(prompts, 2);
    settle!(false);
    assert.equal(await c, false, 'cancel surfaces the original error to the caller');
  } finally {
    unregister();
  }
});

test('0196: a challenge in flight for one token does not answer for another', async () => {
  let prompts = 0;
  let settle: ((proven: boolean) => void) | null = null;
  const unregister = registerStepUpHandler(() => {
    prompts += 1;
    return new Promise<boolean>((resolve) => { settle = resolve; });
  });
  try {
    const a = requestStepUp('t1');
    // A proof is bound server-side to the token that earned it, so an impersonation swap mid-flight
    // gets its own error rather than a second modal over the first.
    assert.equal(await requestStepUp('t2'), false);
    assert.equal(prompts, 1);
    settle!(true);
    assert.equal(await a, true);
  } finally {
    unregister();
  }
});

test('0196: a handler that throws resolves false — never a second error over the operator’s real one', async () => {
  const unregister = registerStepUpHandler(() => Promise.reject(new Error('boom')));
  try {
    assert.equal(await requestStepUp('t1'), false);
    assert.equal(await requestStepUp('t1'), false, 'the failed challenge did not stay pending');
  } finally {
    unregister();
  }
});

test('0196: SESSION_IDLE reaches the mounted handler, and is a no-op once nothing is mounted', () => {
  let ended = 0;
  const unregister = registerSessionIdleHandler(() => { ended += 1; });
  reportSessionIdle();
  reportSessionIdle();   // several in-flight 401s report it; clearing twice must be harmless
  assert.equal(ended, 2);
  unregister();
  reportSessionIdle();
  assert.equal(ended, 2);
});
