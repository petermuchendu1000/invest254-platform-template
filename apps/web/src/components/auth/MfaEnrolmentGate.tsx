'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { authErrorMessage } from '@/lib/auth/errors';
import { cn } from '@/lib/cn';
import type { MfaEnrollDto } from '@/lib/api/types';

/*
 * Mandatory 2FA (TOTP) enrolment gate (Issue 2) — the possession second factor for PRIVILEGED
 * (admin / platform_admin / platform_superadmin) operator accounts.
 *
 * Renders a FULL-SCREEN, NON-DISMISSIBLE overlay (no close, no backdrop-click, no Esc) whenever the
 * signed-in account is flagged `mfaSetupRequired` by /auth/me. The operator must scan (or key) the
 * secret into an authenticator app and confirm a code before continuing. Enforcement is ALSO
 * server-side: once enabled, sign-in demands a TOTP code (MFA_REQUIRED), so a bypassed client cannot
 * skip protection. Mirrors the security-questions gate (knowledge factor); together they make every
 * admin account recoverable (questions) AND phishing/takeover-resistant (2FA).
 *
 * UX / PSYCHOLOGY:
 *   - RATIONALE FIRST: lead with *why* (account-takeover risk) — honest reasons lift voluntary
 *     compliance far more than a bare demand.
 *   - ONE CLEAR PATH: enrol → save recovery codes (explicit acknowledgement) → confirm a code. A
 *     live step indicator gives progress/competence and reduces form anxiety (goal-gradient).
 *   - LOSS AVERSION, gently: recovery codes are framed as the way to *keep* access if the phone is
 *     lost, so saving them protects something they already own.
 *   Visual language matches the exchange-grade auth surface: restrained, single accent, no gradients.
 */

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

/** Group a base32 secret into 4-char blocks for readable manual entry. */
function groupSecret(s: string): string {
  return s.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export function MfaEnrolmentGate() {
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  // Sequence after the security-questions gate: handle knowledge factor first, then the possession
  // factor, so the two mandatory overlays never stack on top of each other.
  const needed = Boolean(token && user?.mfaSetupRequired && !user?.securitySetupRequired);

  const [enroll, setEnroll] = useState<MfaEnrollDto | null>(null);
  const [code, setCode] = useState('');
  const [savedCodes, setSavedCodes] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Begin enrolment once the gate is active (returns secret + otpauth URI + recovery codes ONCE).
  useEffect(() => {
    if (!needed || !token) return;
    let active = true;
    api
      .mfaEnroll(token)
      .then((r) => { if (active) setEnroll(r); })
      .catch(() => { if (active) setError('Could not start 2FA setup. Please refresh and try again.'); });
    return () => { active = false; };
  }, [needed, token]);

  // Lock background scroll while the mandatory gate is up.
  useEffect(() => {
    if (!needed) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [needed]);

  if (!needed) return null;

  const codeValid = /^\d{6}$/.test(code.trim());
  const canConfirm = Boolean(enroll) && savedCodes && codeValid && !busy;

  async function copyCodes() {
    if (!enroll) return;
    try { await navigator.clipboard.writeText(enroll.recoveryCodes.join('\n')); } catch { /* clipboard blocked — codes are visible on screen */ }
  }

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token || !enroll) return;
    if (!savedCodes) { setError('Please confirm you have saved your recovery codes first.'); return; }
    if (!codeValid) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true);
    try {
      await api.mfaConfirm(token, code.trim());
      // Refetch the profile → clears mfaSetupRequired and dismisses the gate.
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
      className="fixed inset-0 z-[61] flex items-stretch justify-center overflow-y-auto sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Set up two-factor authentication"
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
            <h2 className="text-lg font-semibold tracking-tight text-fg">Set up two-factor authentication</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Your admin account controls money and player data, so 2FA is{' '}
              <span className="font-medium text-fg">required</span>. Scan the code with an authenticator
              app (Google Authenticator, Authy, 1Password), save your recovery codes, then enter a code
              to finish. You&apos;ll enter a code each time you sign in.
            </p>
          </div>
        </div>

        {!enroll ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted">
            <Spinner /> Preparing your 2FA secret…
          </div>
        ) : (
          <form className="flex flex-col gap-5 px-6 pt-5" onSubmit={onConfirm} noValidate>
            {/* Step 1 — scan / key the secret */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="mx-auto shrink-0 rounded-xl bg-white p-3 ring-1 ring-black/5">
                <QRCodeSVG value={enroll.otpauthUrl} size={132} level="M" includeMargin={false} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg">1 · Add to your authenticator</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Scan the QR, or enter this key manually:
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs tracking-wider text-fg">
                    {showSecret ? groupSecret(enroll.secret) : '•••• •••• •••• ••••'}
                  </code>
                  <button type="button" onClick={() => setShowSecret((v) => !v)} className="shrink-0 text-xs text-accent hover:underline">
                    {showSecret ? 'Hide' : 'Show'}
                  </button>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(enroll.secret).catch(() => {})} className="shrink-0 text-xs text-accent hover:underline">
                    Copy
                  </button>
                </div>
              </div>
            </div>

            {/* Step 2 — recovery codes */}
            <div className="rounded-brand border border-border bg-surface-2/40 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium text-fg">2 · Save your recovery codes</p>
                <button type="button" onClick={copyCodes} className="text-xs text-accent hover:underline">Copy all</button>
              </div>
              <p className="mt-1 text-xs text-muted">Use one of these if you lose your phone. Each works once. Store them somewhere safe.</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {enroll.recoveryCodes.map((c) => (
                  <code key={c} className="rounded-md border border-border bg-surface px-2 py-1 text-center font-mono text-xs tracking-wider text-fg">{c}</code>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" checked={savedCodes} onChange={(e) => setSavedCodes(e.target.checked)} className="h-4 w-4 rounded border-border accent-accent" />
                I have saved my recovery codes
              </label>
            </div>

            {/* Step 3 — confirm */}
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-medium text-fg">3 · Enter a code to activate</p>
              <Input
                name="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={!savedCodes}
              />
            </div>

            {error ? (
              <p className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-down" role="alert">
                <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" /><circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
                </svg>
                <span>{error}</span>
              </p>
            ) : null}

            <Button type="submit" size="lg" fullWidth disabled={!canConfirm} className="mt-1 font-semibold">
              {busy ? (<><Spinner /> Activating…</>) : 'Activate 2FA & continue'}
            </Button>
          </form>
        )}

        <div className="mt-2 border-t border-border px-6 py-4">
          <p className="text-center text-xs text-muted">TOTP · Codes stored hashed · Admin security</p>
        </div>
      </div>
    </div>
  );
}
