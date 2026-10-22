/**
 * What to tell an operator when console sign-in fails.
 *
 * The form used to map three codes — MFA_REQUIRED, MFA_INVALID, INVALID_CREDENTIALS — and collapse
 * everything else into "Sign-in failed. Please try again.". Everything else is the interesting half:
 * the IP throttle (429), a suspended account, a 500 out of the API, a browser that never reached it
 * at all, and the one that looks identical to all of those but is not a sign-in failure — a session
 * refused by the token gate on the `/auth/me` call that runs immediately after a SUCCESSFUL login.
 * One message for five causes means the operator retries the one thing that was never wrong (their
 * code), and nobody can tell from a screenshot which of the five it was.
 *
 * So: a sentence saying what happened and what to do about it, plus the code and status for the
 * failures whose real answer is in a log rather than in the form. Deliberately NOT shared with the
 * player modal (lib/auth/errors.ts): a player must never be shown an error code, and an operator
 * debugging their own console needs exactly that.
 */

export interface SignInFailure {
  /** What the operator reads first — what happened, and what to do about it. */
  message: string;
  /** Code + HTTP status, when naming them helps. Null when the message is the whole story. */
  detail: string | null;
}

/**
 * The ApiError shape, duck-typed. This module imports nothing (the `@/` alias does not resolve
 * under the repo's node:test runner), and a structural check is also what survives an error that
 * crossed a bundle boundary and lost its prototype.
 */
function asApiError(err: unknown): { code: string; status: number } | null {
  if (!err || typeof err !== 'object') return null;
  const { code, status } = err as { code?: unknown; status?: unknown };
  if (typeof code !== 'string' || typeof status !== 'number') return null;
  return { code, status };
}

export function signInFailure(err: unknown, opts: { usingRecovery?: boolean } = {}): SignInFailure {
  const api = asApiError(err);
  // `fetch` rejected before there was any response to read: DNS, TLS, CORS, a sleeping API machine,
  // a wrong API base URL. No status exists, so saying "sign-in failed" would be a guess.
  if (!api) {
    return { message: 'Could not reach the server. Check the connection, then try again.', detail: 'no response from the API' };
  }
  const detail = `${api.code} · HTTP ${api.status}`;

  switch (api.code) {
    case 'MFA_REQUIRED':
      // Also what an EMPTY second factor gets back (the form is noValidate), so it must name the
      // field the operator is actually looking at.
      return { message: opts.usingRecovery ? 'Enter a recovery code.' : 'Enter your 6-digit code.', detail: null };
    case 'MFA_INVALID':
      return {
        message: opts.usingRecovery
          ? 'That recovery code is not valid, or it has already been used.'
          : 'Incorrect or expired code. Each code works once — if you just used this one, wait for the next.',
        detail: null,
      };
    case 'INVALID_CREDENTIALS':
      // The 0197 lockout answers with this code too, deliberately (telling the two apart would make
      // the lock an account-enumeration oracle). The clause says so without saying which happened.
      return { message: 'Incorrect credentials. Repeated failures also lock the account for a short while.', detail: null };
    case 'ACCOUNT_SUSPENDED':
      return { message: 'This account is suspended, so it cannot open an operator session.', detail };
    case 'ACCOUNT_BANNED':
      return { message: 'This account is banned, so it cannot open an operator session.', detail };
    case 'RATE_LIMITED':
      return { message: 'Too many sign-in attempts from this network. Wait a minute, then try again.', detail };
    // The token gate refusing the session that was just issued. These are `/auth/me`'s codes, not
    // the login's — the password and the code were both accepted. The usual causes are a
    // force-logout epoch newer than the token (the API host's clock behind the database's) and an
    // account that is no longer active.
    case 'AUTH_INVALID':
    case 'AUTH_REQUIRED':
    case 'SESSION_IDLE':
      return { message: 'Signed in, but the session was refused immediately. Try once more; if it repeats, the API log names the gate that rejected it.', detail };
    default:
      break;
  }

  if (api.status === 429) {
    return { message: 'Too many sign-in attempts from this network. Wait a minute, then try again.', detail };
  }
  if (api.status >= 500) {
    return { message: 'The server failed while completing sign-in. Your code is not the problem — the error is in the API log.', detail };
  }
  return { message: 'Sign-in failed. Please try again.', detail };
}
