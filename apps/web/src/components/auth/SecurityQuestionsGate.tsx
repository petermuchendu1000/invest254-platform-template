'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { authErrorMessage } from '@/lib/auth/errors';
import { cn } from '@/lib/cn';
import type { SecurityQuestionDto } from '@/lib/api/types';

/*
 * Mandatory security-questions setup gate (0097) — the knowledge second factor that protects
 * PRIVILEGED (admin / superadmin / platform_superadmin) password resets.
 *
 * It renders a FULL-SCREEN, NON-DISMISSIBLE overlay (no close button, no backdrop-click, no Esc)
 * whenever the signed-in account is flagged `securitySetupRequired`. The account has just been
 * force-logged-out and must set three answers before continuing. Enforcement is ALSO server-side
 * (the reset endpoint fails closed), so this gate is the humane front door, not the lock itself.
 *
 * UX / PSYCHOLOGY (documented in docs + PR):
 *   - RATIONALE FIRST: we lead with *why* (an explicit account-takeover risk). A clear, honest
 *     reason raises voluntary compliance (self-determination / autonomy) far more than a bare demand.
 *   - LOSS AVERSION, gently: we frame the answers as the key to *recovering their own account*, so
 *     completing setup protects something they already own.
 *   - REDUCED CHOICE OVERLOAD: one question per row via a curated dropdown; already-picked questions
 *     disappear from the other rows so a valid, distinct set is the path of least resistance.
 *   - PROGRESS + COMPETENCE: a live "x of 3 ready" indicator and inline validation give feedback and
 *     a sense of momentum (goal-gradient), reducing form anxiety.
 *   - REASSURANCE: we state answers are encrypted and matching is case-insensitive, removing the two
 *     most common hesitations (privacy fear + "will my capitalisation matter?").
 *   Visual language matches the exchange-grade auth surface: restrained, single accent, no gradients.
 */

const REQUIRED = 3;
const ANSWER_MIN = 2;

interface Row {
  key: string;
  answer: string;
}

function ShieldCheck() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
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

export function SecurityQuestionsGate() {
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  // Show only when the server flagged this (already privileged-only) account for setup.
  const needed = Boolean(token && user?.securitySetupRequired);

  const [catalog, setCatalog] = useState<SecurityQuestionDto[]>([]);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: REQUIRED }, () => ({ key: '', answer: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the question catalog once the gate is active.
  useEffect(() => {
    if (!needed) return;
    let active = true;
    api
      .securityQuestionsCatalog()
      .then((r) => {
        if (active) setCatalog(r.questions);
      })
      .catch(() => {
        if (active) setError('Could not load the security questions. Please refresh and try again.');
      });
    return () => {
      active = false;
    };
  }, [needed]);

  // Lock background scroll while the mandatory gate is up.
  useEffect(() => {
    if (!needed) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [needed]);

  const chosenKeys = rows.map((r) => r.key).filter(Boolean);
  const readyCount = rows.filter((r) => r.key && r.answer.trim().length >= ANSWER_MIN).length;
  const complete = readyCount === REQUIRED && new Set(chosenKeys).size === REQUIRED;

  // Options available to a given row: unpicked questions + this row's own current pick.
  const optionsFor = useMemo(() => {
    return (rowIndex: number): SecurityQuestionDto[] => {
      const takenByOthers = new Set(rows.filter((_, i) => i !== rowIndex).map((r) => r.key).filter(Boolean));
      return catalog.filter((q) => !takenByOthers.has(q.key));
    };
  }, [catalog, rows]);

  if (!needed) return null;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!complete) {
      setError('Pick three different questions and answer each one (at least 2 characters).');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      await api.setSecurityQuestions(
        token,
        rows.map((r) => ({ key: r.key, answer: r.answer })),
      );
      // Refetch the profile → clears securitySetupRequired and dismisses the gate.
      const me = await api.me(token);
      setUser(me);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-center overflow-y-auto sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Set up your security questions"
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
            <ShieldCheck />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-fg">Secure your admin account</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              To protect your account from password-reset takeover, admins must set{' '}
              <span className="font-medium text-fg">three security questions</span>. You&apos;ll answer these
              to reset your password in the future. This is required before you continue.
            </p>
          </div>
        </div>

        <form className="flex flex-col gap-4 px-6 pt-5" onSubmit={onSubmit} noValidate>
          {/* Progress */}
          <div className="flex items-center gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn('h-1.5 flex-1 rounded-full transition-colors', i < readyCount ? 'bg-accent' : 'bg-border')}
              />
            ))}
            <span className="w-16 shrink-0 text-right text-[11px] font-medium text-muted">{readyCount} of {REQUIRED}</span>
          </div>

          {rows.map((row, i) => {
            const opts = optionsFor(i);
            return (
              <div key={i} className="flex flex-col gap-2 rounded-brand border border-border bg-surface-2/40 p-3">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-fg">
                    Question {i + 1}
                    <span className="text-down" aria-hidden> *</span>
                  </span>
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
                      required
                      aria-label={`Security question ${i + 1}`}
                    >
                      <option value="" disabled>
                        Choose a question…
                      </option>
                      {opts.map((q) => (
                        <option key={q.key} value={q.key}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
                <Input
                  label={undefined}
                  name={`answer-${i}`}
                  placeholder="Your answer"
                  autoComplete="off"
                  value={row.answer}
                  onChange={(e) => setRow(i, { answer: e.target.value })}
                  disabled={!row.key}
                />
              </div>
            );
          })}

          <p className="text-xs leading-relaxed text-muted">
            Answers are encrypted and matching is case-insensitive. Choose answers you&apos;ll remember —
            you&apos;ll need them to recover your account.
          </p>

          {error ? (
            <p
              className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-down"
              role="alert"
            >
              <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" />
                <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
              </svg>
              <span>{error}</span>
            </p>
          ) : null}

          <Button type="submit" size="lg" fullWidth disabled={busy || !complete} className="mt-1 font-semibold">
            {busy ? (
              <>
                <Spinner />
                Saving…
              </>
            ) : (
              'Save & continue'
            )}
          </Button>
        </form>

        <div className="mt-2 border-t border-border px-6 py-4">
          <p className="text-center text-xs text-muted">Encrypted in transit · Stored hashed · Admin security</p>
        </div>
      </div>
    </div>
  );
}
