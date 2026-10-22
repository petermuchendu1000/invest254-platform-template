'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { roleFromToken } from '@/lib/auth/token';
import { isPrivilegedRole } from '@/lib/auth/operatorSession';
import { registerStepUpHandler } from '@/lib/auth/stepUp';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import type { SecurityQuestionDto, StepUpStatusDto } from '@/lib/api/types';

/*
 * Step-up second factor at the moment of the action (0196) — the prompt that satisfies the server
 * gate in apps/api/src/stepup.ts.
 *
 * Every mutating admin/platform route answers 403 STEP_UP_REQUIRED until a second factor has been
 * proven for the session. `apiFetch` raises the challenge here and REPLAYS the refused call once the
 * proof lands (see lib/auth/stepUp.ts), so the operator's click is not lost and the form they just
 * filled in is not thrown away.
 *
 * WHICH factor is asked for comes from GET /auth/step-up and nowhere else. The role-to-factor rule
 * is the server's (possession for the platform tiers, knowledge for a site admin); re-deriving it
 * here would be a second copy of a security policy, and the copy nobody looks at is the one that
 * drifts.
 *
 * NON-DISMISSIBLE while a challenge is pending — no backdrop click, no Esc — because the overlay is
 * not an interruption to be flicked away: a refused call is waiting behind it. Cancel is explicit,
 * and rejects that call with its original error.
 *
 * IT MUST OUTRANK EVERY OTHER OVERLAY (z-index 102). Non-dismissible and unreachable is a deadlock,
 * and that is exactly what shipped: the gate sat at z-index 62 while RejectDialog sat at 70, so a
 * reject launched FROM a dialog raised a challenge that rendered underneath it. The promise never
 * settled, the mutation never finished, and because the panel disables its buttons on the shared
 * `isPending`, one stuck reject disabled approve AND reject on every row until a reload. See
 * BUGLOG #152. `gates.z.test.ts` fails if any `fixed` overlay is given a z at or above the gates.
 *
 * Privileged roles only. A player or marketer never mounts this: they have no privileged surface,
 * the server never answers them STEP_UP_REQUIRED, and they are most of the traffic.
 *
 * UX, following MfaEnrolmentGate / SecurityQuestionsGate:
 *   - RATIONALE FIRST: say plainly what was being attempted and why a code is wanted now.
 *   - NO DEAD END: the authenticator path always offers the recovery code, so a lost or re-flashed
 *     phone does not leave an operator staring at a queue they cannot work.
 *   - HONEST ABOUT THE WINDOW: we state how long this confirmation lasts, so it reads as a short
 *     renewal rather than a code per click.
 */

const REQUIRED_ANSWERS = 3;
const ANSWER_MIN = 2;

/** Copy for the codes POST /auth/step-up can return (apps/engine/src/authservice.ts verifyStepUp). */
const MESSAGES: Record<string, string> = {
  MFA_REQUIRED: 'Enter the 6-digit code from your authenticator app.',
  MFA_INVALID: 'That code was not accepted. Codes work once — wait for the next one and try again.',
  SECURITY_QUESTIONS_NOT_SET: 'Your security questions are not set up yet. Sign out and back in to set them.',
  SECURITY_ANSWERS_MISMATCH: 'Those answers do not match the three questions on your account.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
};

function messageFor(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.message ?? 'Could not confirm. Please try again.';
  return 'Network error. Please check your connection and try again.';
}

function ShieldLock() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" />
      <path d="M12 11v3M9.5 11.5a2.5 2.5 0 015 0v.5h-5z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** "5 minutes" / "90 seconds" — the window as the server reports it, never hard-coded here. */
function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'a few minutes';
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

interface Challenge {
  token: string | null;
  /** Resolves the refused call's replay (true) or lets its original 403 surface (false). */
  settle: (proven: boolean) => void;
}

interface AnswerRow {
  key: string;
  answer: string;
}

export function StepUpGate() {
  const token = useSession((s) => s.token);
  // The TOKEN role, not /auth/me: the token is what the API gates on, and an impersonated brand
  // session must be challenged as the brand admin it actually is.
  const privileged = isPrivilegedRole(roleFromToken(token));

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<StepUpStatusDto | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [catalog, setCatalog] = useState<SecurityQuestionDto[]>([]);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [rows, setRows] = useState<AnswerRow[]>(() => Array.from({ length: REQUIRED_ANSWERS }, () => ({ key: '', answer: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Register the broker handler. Only for a privileged session: with nothing registered, requestStepUp
  // resolves false and the caller keeps its own error, so a player's request can never hang on a
  // prompt that would never appear.
  useEffect(() => {
    if (!privileged) return;
    return registerStepUpHandler(
      (req) =>
        new Promise<boolean>((resolve) => {
          setStatus(null);
          setStatusError(false);
          setError(null);
          setCode('');
          setRecovery('');
          setUseRecovery(false);
          setRows(Array.from({ length: REQUIRED_ANSWERS }, () => ({ key: '', answer: '' })));
          setChallenge({ token: req.token, settle: resolve });
        }),
    );
  }, [privileged]);

  // Ask the server what this session must prove. Done per challenge rather than cached, because
  // `satisfied` and the window are facts about right now — and because this endpoint is the only
  // place the required factor comes from.
  useEffect(() => {
    const c = challenge;
    if (!c) return;
    // No token to prove anything with (the session went away between the 403 and the prompt): close
    // rather than leave a modal asking for a code that could not be checked against anything.
    if (!c.token) { c.settle(false); setChallenge(null); return; }
    let alive = true;
    api
      .stepUpStatus(c.token)
      .then((s) => {
        if (!alive) return;
        // Already proven inside the window — another tab, or a call that raced ahead of this one.
        // Replay the refused request without making the operator type a code they just typed.
        if (s.satisfied) { c.settle(true); setChallenge(null); return; }
        // No factor to ask for (a non-gated account reaching this somehow): there is no prompt that
        // could satisfy the 403, so let the caller's own error through instead of spinning forever.
        if (!s.required || !s.factor) { c.settle(false); setChallenge(null); return; }
        setStatus(s);
      })
      .catch(() => { if (alive) setStatusError(true); });
    return () => { alive = false; };
  }, [challenge]);

  // GET /auth/step-up tells us WHICH three questions this operator actually chose, so the prompt
  // asks those and nothing else. The catalog is still fetched, but only for the LABELS.
  //
  // This is the one place the step-up prompt differs from SecurityQuestionsGate, deliberately: that
  // gate is setting answers for the first time and must offer the whole catalog, whereas this one is
  // verifying answers that already exist. Offering all ten here would make an operator guess which
  // three they picked against a 10/min budget, and for the admin tier -- whose second factor IS the
  // questions -- guessing wrong means locked out of every critical action on the platform.
  const needsQuestions = status?.factor === 'security_questions';
  const myKeys = status?.questionKeys;
  useEffect(() => {
    if (!needsQuestions || catalog.length > 0) return;
    let active = true;
    api
      .securityQuestionsCatalog()
      .then((r) => { if (active) setCatalog(r.questions); })
      .catch(() => { if (active) setError('Could not load your security questions. Please try again.'); });
    return () => { active = false; };
  }, [needsQuestions, catalog.length]);

  // Pin the three rows to the operator's own questions once the server has named them, so the form
  // is "answer these three" rather than "pick three and answer them".
  useEffect(() => {
    if (!needsQuestions || !myKeys || myKeys.length === 0) return;
    setRows((prev) => {
      if (prev.length === myKeys.length && prev.every((r, i) => r.key === myKeys[i])) return prev; // already pinned
      return myKeys.map((key, i) => ({ key, answer: prev[i]?.answer ?? '' }));
    });
  }, [needsQuestions, myKeys]);

  // A session that dies under the modal (SESSION_IDLE elsewhere, or a sign-out in another tab) must
  // not leave a prompt stranded over the sign-in screen asking for a code no one can supply.
  useEffect(() => {
    if (challenge && !token) {
      challenge.settle(false);
      setChallenge(null);
    }
  }, [challenge, token]);

  // Lock background scroll while the challenge is up (same as the other two gates).
  useEffect(() => {
    if (!challenge) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [challenge]);

  // Pinned = the server named this operator's own questions, so the form asks exactly those. The
  // unpinned path (setup never finished, or the status call failed) keeps the old pick-three form
  // rather than showing an operator an empty dialog they cannot act on.
  const pinned = Boolean(needsQuestions && myKeys && myKeys.length > 0);
  const labelFor = useMemo(() => {
    const byKey = new Map(catalog.map((q) => [q.key, q.label]));
    // Fall back to the key itself if the catalog has not arrived: an operator can still recognise
    // `first_pet`, whereas a blank line tells them nothing.
    return (key: string): string => byKey.get(key) ?? key;
  }, [catalog]);

  const optionsFor = useMemo(() => {
    return (rowIndex: number): SecurityQuestionDto[] => {
      const takenByOthers = new Set(rows.filter((_, i) => i !== rowIndex).map((r) => r.key).filter(Boolean));
      return catalog.filter((q) => !takenByOthers.has(q.key));
    };
  }, [catalog, rows]);

  if (!privileged || !challenge) return null;

  const active = challenge;   // narrowed once, so the handlers below cannot see a null challenge
  const factor = status?.factor ?? null;
  const codeValid = /^\d{6}$/.test(code.trim());
  const recoveryValid = recovery.trim().length >= 8;
  const answersComplete =
    rows.filter((r) => r.key && r.answer.trim().length >= ANSWER_MIN).length === REQUIRED_ANSWERS &&
    new Set(rows.map((r) => r.key)).size === REQUIRED_ANSWERS;
  const canSubmit =
    !busy &&
    (factor === 'totp' ? (useRecovery ? recoveryValid : codeValid) : factor === 'security_questions' ? answersComplete : false);

  function setRow(i: number, patch: Partial<AnswerRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function finish(proven: boolean) {
    active.settle(proven);
    setChallenge(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const t = active.token;
    if (!t || !factor) return;
    setBusy(true);
    try {
      if (factor === 'totp') {
        await api.stepUpVerify(t, useRecovery ? { recovery_code: recovery.trim() } : { code: code.trim() });
      } else {
        await api.stepUpVerify(t, { answers: rows.map((r) => ({ key: r.key, answer: r.answer })) });
      }
      // Proven: the waiting call is replayed by apiFetch, so the operator's action completes itself.
      finish(true);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[102] flex items-stretch justify-center overflow-y-auto sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm this action"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
      <div
        className={cn(
          'relative z-10 flex w-full flex-col bg-surface outline-none',
          'border border-border shadow-2xl shadow-black/60 ring-1 ring-white/5',
          'sm:my-8 sm:max-w-lg sm:rounded-2xl',
        )}
      >
        {/* Header — rationale first */}
        <div className="flex items-start gap-3 border-b border-border px-6 pb-5 pt-6">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10">
            <ShieldLock />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-fg">Confirm it&apos;s you</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {/* Named only once the server has said which factor it wants — the client never
                  guesses that from the role (see apps/api/src/stepup.ts). */}
              This action changes money, access or settings, so we ask you to confirm{' '}
              {factor === 'security_questions' ? 'with your security answers' : factor === 'totp' ? 'with your authenticator code' : 'it is you'}{' '}
              before it goes through — a signed-in session on an unattended screen is not proof that
              you are the one clicking.
              {status?.windowSeconds ? (
                <>
                  {' '}Confirming once covers the next{' '}
                  <span className="font-medium text-fg">{windowLabel(status.windowSeconds)}</span> of
                  admin actions, then we ask again.
                </>
              ) : null}
            </p>
          </div>
        </div>

        {statusError ? (
          <div className="flex flex-col gap-4 px-6 py-8">
            <p className="text-sm text-muted">
              We could not check what this session needs to confirm. Your action was not carried out.
            </p>
            <Button type="button" size="lg" fullWidth onClick={() => finish(false)}>Close</Button>
          </div>
        ) : !factor ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted">
            <Spinner /> Checking…
          </div>
        ) : (
          <form className="flex flex-col gap-4 px-6 pt-5" onSubmit={onSubmit} noValidate>
            {factor === 'totp' ? (
              <>
                {useRecovery ? (
                  <Input
                    label="Recovery code"
                    name="recovery-code"
                    autoComplete="one-time-code"
                    placeholder="xxxx-xxxx-xxxx"
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    hint="Each recovery code works once."
                  />
                ) : (
                  <Input
                    label="Authenticator code"
                    name="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                )}
                <button
                  type="button"
                  onClick={() => { setUseRecovery((v) => !v); setError(null); }}
                  className="self-start text-xs text-accent hover:underline"
                >
                  {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-muted">
                  {pinned
                    ? 'Answer the three questions you set for your account. Matching is case-insensitive.'
                    : 'Pick the three questions you set for your account and answer each one. Matching is case-insensitive.'}
                </p>
                {rows.map((row, i) => {
                  const opts = optionsFor(i);
                  return (
                    <div key={i} className="flex flex-col gap-2 rounded-brand border border-border bg-surface-2/40 p-3">
                      {/* When the server has named this operator's own questions, the question is a
                          STATEMENT, not a choice. Leaving it selectable would let them switch to a
                          question they never set and then fail the challenge for a reason the error
                          cannot explain. The select remains for the fallback path below. */}
                      {pinned ? (
                        <span className="flex flex-col gap-1.5 text-sm">
                          <span className="font-medium text-muted">Question {i + 1}</span>
                          <span className="text-fg">{labelFor(row.key)}</span>
                        </span>
                      ) : (
                      <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium text-fg">Question {i + 1}</span>
                        <span
                          className={cn(
                            'group flex items-center rounded-brand border bg-surface-2 transition',
                            'focus-within:ring-2 focus-within:ring-accent focus-within:border-accent border-border',
                          )}
                        >
                          <select
                            className="h-12 w-full rounded-brand bg-transparent px-3.5 text-fg outline-none"
                            value={row.key}
                            onChange={(e) => setRow(i, { key: e.target.value })}
                            aria-label={`Security question ${i + 1}`}
                          >
                            <option value="" disabled>Choose a question…</option>
                            {opts.map((q) => (
                              <option key={q.key} value={q.key}>{q.label}</option>
                            ))}
                          </select>
                        </span>
                      </label>
                      )}
                      <Input
                        label={undefined}
                        name={`step-up-answer-${i}`}
                        placeholder="Your answer"
                        autoComplete="off"
                        value={row.answer}
                        onChange={(e) => setRow(i, { answer: e.target.value })}
                        disabled={!row.key}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {error ? (
              <p className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-down" role="alert">
                <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" /><circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
                </svg>
                <span>{error}</span>
              </p>
            ) : null}

            <Button type="submit" size="lg" fullWidth disabled={!canSubmit} className="mt-1 font-semibold">
              {busy ? (<><Spinner /> Confirming…</>) : 'Confirm & continue'}
            </Button>
          </form>
        )}

        {/* The ONLY way out other than confirming — there is no backdrop click and no Esc, because a
            refused call is waiting behind this. Cancelling rejects it with the error it already had.
            Rendered outside the branches above so a prompt can always be closed, including while the
            required factor is still being fetched. */}
        {statusError ? null : (
          <button
            type="button"
            onClick={() => finish(false)}
            disabled={busy}
            className="mx-auto mt-4 text-xs text-muted underline underline-offset-2 transition hover:text-fg disabled:opacity-50"
          >
            Cancel this action
          </button>
        )}

        <div className="mt-2 border-t border-border px-6 py-4">
          <p className="text-center text-xs text-muted">
            {factor === 'security_questions' ? 'Security answers · Stored hashed · Admin security' : 'TOTP · Single-use codes · Admin security'}
          </p>
        </div>
      </div>
    </div>
  );
}
