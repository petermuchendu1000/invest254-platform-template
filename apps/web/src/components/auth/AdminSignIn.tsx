'use client';

import * as React from 'react';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { ApiError } from '@/lib/api/client';
import { useSessionEnd } from '@/lib/auth/operatorSession';
import { phoneDisplay, isMaskedValue } from '@/lib/auth/phoneMask';
import { signInFailure, type SignInFailure } from '@/lib/auth/signInError';

/**
 * Operator sign-in. Deliberately MINIMAL: brand + credentials only. It states nothing about who the
 * console is for, the role model, tenancy, or auditing — that would hand an attacker a map. The
 * server enforces all authorisation; the UI just collects a credential.
 */

function Field({
  label, type, name, value, onChange, placeholder, autoComplete, inputMode, trailing, required, onFocus, onBlur,
}: {
  label: string; type: string; name: string; value: string; onChange: (v: string) => void;
  placeholder?: string; autoComplete?: string; inputMode?: 'tel' | 'numeric' | 'text'; trailing?: React.ReactNode; required?: boolean;
  onFocus?: () => void; onBlur?: () => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-fg/90">{label}</span>
      <span className="group relative flex items-center rounded-xl border border-border bg-surface-2/70 transition focus-within:border-[#3b6ef6] focus-within:ring-2 focus-within:ring-[#3b6ef6]/40">
        <input
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          required={required}
          className="h-12 w-full rounded-xl bg-transparent px-4 text-[15px] text-fg outline-none placeholder:text-muted/70"
        />
        {trailing ? <span className="absolute right-2 flex items-center">{trailing}</span> : null}
      </span>
    </label>
  );
}

export function AdminSignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const { adminLogin } = useAuthActions();
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [totp, setTotp] = React.useState('');
  const [needsTotp, setNeedsTotp] = React.useState(false);
  const [useRecovery, setUseRecovery] = React.useState(false);   // authenticator lost: spend a recovery code
  const [showPw, setShowPw] = React.useState(false);
  const [showPhone, setShowPhone] = React.useState(false);     // live-stream safety (see the phone Field)
  const [phoneFocused, setPhoneFocused] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<SignInFailure | null>(null);
  // Why this screen appeared without being asked for (0196): a five-minute idle timeout ended the
  // session. Said plainly and without alarm, because the operator did nothing wrong — the alternative
  // is a console that looks like it dropped their work for no reason.
  const endedReason = useSessionEnd((s) => s.reason);
  const setEndedReason = useSessionEnd((s) => s.setReason);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setEndedReason(null);   // they are signing in again: the explanation has served its purpose
    setBusy(true);
    try {
      const second = useRecovery ? { recoveryCode: totp.trim() } : { totp: totp.trim() };
      await adminLogin(phone.trim(), password, needsTotp ? second : undefined);
      onSignedIn?.();
    } catch (err) {
      // MFA_REQUIRED is the server ASKING for the second factor, not refusing one: reveal the field.
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setNeedsTotp(true);
      // Everything else is named rather than flattened into one sentence — lib/auth/signInError.ts
      // says why: five unrelated causes wearing the same words is a console nobody can debug.
      setError(signInFailure(err, { usingRecovery: useRecovery }));
    } finally { setBusy(false); }
  }

  // Shared eye glyph for the reveal toggles below (phone + password).
  const eyeFor = (shown: boolean, toggle: () => void, what: string) => (
    <button
      type="button"
      onClick={toggle}
      aria-label={`${shown ? 'Hide' : 'Show'} ${what}`}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg"
    >
      {shown ? (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22M9.53 9.53a3 3 0 004.24 4.24" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="3" /></svg>
      )}
    </button>
  );

  const eye = (
    <button
      type="button"
      onClick={() => setShowPw((v) => !v)}
      aria-label={showPw ? 'Hide password' : 'Show password'}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg"
    >
      {showPw ? (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22M9.53 9.53a3 3 0 004.24 4.24" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="3" /></svg>
      )}
    </button>
  );

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-5 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(50% 40% at 50% 0%, rgba(59,110,246,0.16), transparent 70%), radial-gradient(45% 40% at 85% 100%, rgba(124,58,237,0.14), transparent 70%)' }}
      />
      <div className="relative w-full max-w-[380px]">
        {/* Brand */}
        <div className="mb-7 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/triocodes-mark.png" alt="TrioCodes" className="h-8 w-8 object-contain" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-fg">TrioCodes</span>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-surface/80 p-7 shadow-2xl shadow-black/40 ring-1 ring-white/5 sm:p-8">
          <h1 className="mb-5 text-[22px] font-semibold tracking-tight text-fg">Sign in</h1>
          {endedReason === 'idle' ? (
            <div className="mb-4 rounded-xl border border-border bg-surface-2/70 px-3 py-2.5 text-[13px] leading-relaxed text-muted">
              You were signed out after 5 minutes without activity. Sign in to pick up where you left off.
            </div>
          ) : null}
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {/* Reads as the partial mask 0798****061 at rest (sign-in happens on camera), the real
                digits while editing — an input renders its own value, so it cannot be masked mid-edit
                without corrupting what is posted — and the full number once the eye is on. The '*'
                guard keeps the display mask from ever being read back as input. */}
            <Field label="Phone number" type="tel" name="phone" inputMode="tel" autoComplete="username" placeholder="07XX XXX XXX"
              value={phoneDisplay(phone, showPhone, phoneFocused)}
              onFocus={() => setPhoneFocused(true)} onBlur={() => setPhoneFocused(false)}
              onChange={(v) => { if (!isMaskedValue(v)) setPhone(v); }}
              trailing={eyeFor(showPhone, () => setShowPhone((v) => !v), showPhone ? 'phone number' : 'the hidden digits')} required />
            <Field label="Password" type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={setPassword} trailing={eye} required />
            {needsTotp ? (
              <div className="flex flex-col gap-1.5">
                <Field
                  label={useRecovery ? 'Recovery code' : 'Authentication code'}
                  type="text" name="totp" autoComplete="one-time-code" required
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  placeholder={useRecovery ? 'XXXX-XXXX' : '123456'}
                  value={totp}
                  /* Digits only for a TOTP code: a pasted code carrying a space is refused as
                     MFA_INVALID, which reads as "wrong code" for a code that was right. */
                  onChange={(v) => setTotp(useRecovery ? v.slice(0, 32) : v.replace(/[^0-9]/g, '').slice(0, 6))}
                />
                {/* The API has always accepted `recovery_code` on this route; only the form never
                    offered one, so an operator whose authenticator was gone had no way in at all —
                    and a recovery code typed into the 6-digit box could only ever fail. */}
                <button
                  type="button"
                  onClick={() => { setUseRecovery((v) => !v); setTotp(''); setError(null); }}
                  className="self-start rounded-lg px-1 py-1 text-left text-[12px] font-medium text-muted transition hover:text-fg"
                >
                  {useRecovery ? 'Use the authenticator code instead' : 'Lost your authenticator? Use a recovery code'}
                </button>
              </div>
            ) : null}

            {error ? (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-down/40 bg-down/10 px-3 py-2.5 text-[13px] text-down">
                <svg viewBox="0 0 24 24" className="mt-[2px] h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" /></svg>
                <span className="min-w-0">
                  <span className="block">{error.message}</span>
                  {/* The code and status, for the failures whose real answer is in the API log rather
                      than in this form. An operator reading their own console is who this is for. */}
                  {error.detail ? <span className="mt-0.5 block break-words font-mono text-[11px] text-down/70">{error.detail}</span> : null}
                </span>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="mt-1 h-12 w-full rounded-xl bg-gradient-to-r from-[#2f6bff] to-[#6d3bef] text-[15px] font-semibold text-white shadow-lg shadow-[#3b6ef6]/20 transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b6ef6]/60 disabled:opacity-60"
            >
              {busy ? 'Signing in…' : needsTotp ? 'Verify' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
