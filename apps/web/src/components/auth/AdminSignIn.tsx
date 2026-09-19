'use client';

import * as React from 'react';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { ApiError } from '@/lib/api/client';

/**
 * Operator sign-in. Deliberately MINIMAL: brand + credentials only. It states nothing about who the
 * console is for, the role model, tenancy, or auditing — that would hand an attacker a map. The
 * server enforces all authorisation; the UI just collects a credential.
 */

function Field({
  label, type, name, value, onChange, placeholder, autoComplete, inputMode, trailing, required,
}: {
  label: string; type: string; name: string; value: string; onChange: (v: string) => void;
  placeholder?: string; autoComplete?: string; inputMode?: 'tel' | 'numeric' | 'text'; trailing?: React.ReactNode; required?: boolean;
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
  const [showPw, setShowPw] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await adminLogin(phone.trim(), password, needsTotp ? totp.trim() : undefined);
      onSignedIn?.();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'MFA_REQUIRED') { setNeedsTotp(true); setError('Enter your 6-digit code.'); }
      else if (code === 'MFA_INVALID') setError('Incorrect or expired code.');
      else if (code === 'INVALID_CREDENTIALS') setError('Incorrect credentials.');
      else setError('Sign-in failed. Please try again.');
    } finally { setBusy(false); }
  }

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
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Field label="Phone number" type="tel" name="phone" inputMode="tel" autoComplete="username" placeholder="07XX XXX XXX" value={phone} onChange={setPhone} required />
            <Field label="Password" type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={setPassword} trailing={eye} required />
            {needsTotp ? (
              <Field label="Authentication code" type="text" name="totp" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={totp} onChange={setTotp} required />
            ) : null}

            {error ? (
              <div role="alert" className="flex items-center gap-2 rounded-xl border border-down/40 bg-down/10 px-3 py-2.5 text-[13px] text-down">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" /></svg>
                <span>{error}</span>
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
