/*
 * The client half of the step-up gate (0196). See apps/api/src/stepup.ts for the server half.
 *
 * Every mutating admin/platform route now answers 403 STEP_UP_REQUIRED until a second factor has
 * been proven for that session, and 401 SESSION_IDLE after five minutes of inactivity. Neither code
 * can be satisfied by the caller that received it: the operator has to type a code, and `apiFetch`
 * is not React, so it cannot show them a prompt.
 *
 * This module is the seam between the two. The modal registers a handler here; `apiFetch` asks for a
 * challenge and awaits the answer. The failure this prevents is the one that makes the gate unusable
 * rather than merely strict: without it, every click an operator makes on a payout queue, a wallet
 * adjustment or a gateway credential dies with an error the UI has no way to clear.
 *
 * WHY SINGLE-FLIGHT: a console page fires several mutating calls at once (a panel that saves two
 * settings, a queue that approves in a loop). Each would raise its own challenge and stack a second
 * and third modal over the first, and satisfying one would leave the others asking for a code that
 * is already proven. One challenge is shared by every caller waiting on it; the one proof the
 * operator gives settles all of them.
 */

/** Which second factor the server requires. Mirrors StepUpFactor in apps/api/src/stepup.ts. */
export type StepUpFactor = 'totp' | 'security_questions';

/**
 * Paths that must never raise a challenge, mirroring STEP_UP_EXEMPT in apps/api/src/stepup.ts.
 *
 * These are the calls that EXIST to satisfy or end a challenge. Challenging one is a deadlock: the
 * modal's own `POST /auth/step-up` would wait for a challenge that is waiting for it. The server
 * exempts them too, so in practice this list is belt-and-braces — which is the point, because the
 * cost of being wrong here is a console frozen behind a modal that can never be answered.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/auth/step-up',
  '/auth/logout',
  '/auth/refresh',
  '/auth/mfa/enroll',
  '/auth/mfa/confirm',
  '/auth/security-questions',
]);

export function isStepUpExemptPath(path: string): boolean {
  const base = path.split('?')[0] ?? path;
  return EXEMPT_PATHS.has(base);
}

/**
 * Raises the prompt and resolves true once a second factor has been proven for `token`, false if the
 * operator cancelled or it could not be proven. Never rejects: a rejection here would replace the
 * operator's real error with a secondary one.
 */
export type StepUpChallengeHandler = (req: { token: string | null }) => Promise<boolean>;

let challengeHandler: StepUpChallengeHandler | null = null;
let pending: { token: string | null; promise: Promise<boolean> } | null = null;

/** Mount point for the modal. Returns the unregister function for the effect's cleanup. */
export function registerStepUpHandler(handler: StepUpChallengeHandler): () => void {
  challengeHandler = handler;
  return () => {
    if (challengeHandler === handler) challengeHandler = null;
  };
}

/**
 * Ask the operator for a second factor for `token`.
 *
 * Resolves false — surfacing the caller's original 403 — when there is nothing mounted to ask with
 * (a player session, or a privileged one on a page that never mounted the gate), rather than hanging
 * a request forever on a prompt that will never appear.
 *
 * A proof is bound server-side to the token that earned it, so a challenge in flight for one token
 * says nothing about another (an impersonation swap mid-flight is the real case). Those callers get
 * their original error instead of a second modal on top of the first.
 */
export function requestStepUp(token: string | null): Promise<boolean> {
  if (!challengeHandler) return Promise.resolve(false);
  if (pending) return pending.token === token ? pending.promise : Promise.resolve(false);
  const promise = challengeHandler({ token })
    .catch(() => false)
    .finally(() => {
      pending = null;
    });
  pending = { token, promise };
  return promise;
}

/**
 * Called when the server reports the session is over (401 SESSION_IDLE).
 *
 * The handler clears the session the way the app already does — it lives in React because that is
 * where the session store and the impersonation fence are reachable. There is deliberately no retry
 * and no recovery path: SESSION_IDLE means the token is dead server-side, so anything but signing in
 * again would be a loop against a 401.
 */
export type SessionIdleHandler = () => void;

let idleHandler: SessionIdleHandler | null = null;

export function registerSessionIdleHandler(handler: SessionIdleHandler): () => void {
  idleHandler = handler;
  return () => {
    if (idleHandler === handler) idleHandler = null;
  };
}

export function reportSessionIdle(): void {
  // A dead session usually kills several in-flight requests at once; the handler is idempotent
  // (clearing an already-cleared session is a no-op) so each one reporting it is harmless.
  idleHandler?.();
}
