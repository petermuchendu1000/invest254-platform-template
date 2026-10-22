'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { api } from '@/lib/api/endpoints';
import { useAuthUi } from '@/lib/auth/ui';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useBrand } from '@/lib/brand/BrandProvider';
import { authErrorMessage } from '@/lib/auth/errors';
import { phoneError, usernameError, passwordError, referralError } from '@/lib/auth/validation';
import { REF_KEY } from '@/lib/auth/referral';
import { phoneDisplay, isMaskedValue } from '@/lib/auth/phoneMask';
import { cn } from '@/lib/cn';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import type { RegisterInput } from '@/lib/api/endpoints';

/*
 * Exchange-grade auth surface. Deliberately restrained: one accent colour reserved for the single
 * primary action, left-aligned type hierarchy, quiet underline tabs instead of a filled segmented
 * control, and no decorative gradients — the visual language traders expect from Binance/Kraken
 * style sign-in. Three modes share the shell: log in, sign up, and (no-OTP) password reset.
 */

/* ── inline field icons (currentColor, inherit the muted field colour) ───────── */
const ic = 'h-[18px] w-[18px]';
function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" strokeLinecap="round" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 11.5 11 4h6.5A2.5 2.5 0 0 1 20 6.5V13l-7.5 7.5a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8Z" />
      <circle cx="15" cy="9" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <line x1="4" y1="4" x2="20" y2="20" strokeLinecap="round" /> : null}
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-10 w-10 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="10" opacity="0.35" />
      <path d="M7 12.5l3.2 3.2L17 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
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

/* ── password strength (advisory only; the authoritative rule is validatePassword) ── */
const STRENGTH = [
  { label: 'Too short', tone: 'bg-down' },
  { label: 'Weak', tone: 'bg-down' },
  { label: 'Fair', tone: 'bg-warn' },
  { label: 'Good', tone: 'bg-up' },
  { label: 'Strong', tone: 'bg-up' },
] as const;

function strengthScore(pw: string): number {
  if (!pw) return -1;
  if (pw.length < 8) return 0;
  let s = 1;
  if (pw.length >= 12) s += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s += 1;
  return Math.min(4, s);
}

function StrengthMeter({ password }: { password: string }) {
  const score = strengthScore(password);
  if (score < 0) return null;
  const meta = STRENGTH[score]!;
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn('h-1 flex-1 rounded-full transition-colors', i < Math.max(score, 1) ? meta.tone : 'bg-border')}
          />
        ))}
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] font-medium text-muted">{meta.label}</span>
    </div>
  );
}

/** Autofill / paste: "+254 712 345 678" or "254712345678" → "0712345678" (BUGLOG #101: was cut to "2547123456"). */
function localPhone(v: string): string {
  let d = v.replace(/\D/g, '');
  if (d.startsWith('254') && d.length >= 12) d = `0${d.slice(3)}`;
  else if (d.length === 9 && /^[17]/.test(d)) d = `0${d}`;
  return d.slice(0, 10);
}

export function AuthModal() {
  const { open, mode, openAuth, close } = useAuthUi();
  const { login, register } = useAuthActions();
  const brand = useBrand();
  /**
   * On a terminal brand the sign-in screen is MetaTrader's too. The form itself — validation,
   * two-factor, recovery codes, the reset sub-flow — is not rewritten; re-pointing the theme tokens
   * repaints it (lib/ui/mt5Tokens) and only the header changes, to MetaTrader's blue band.
   */
  const mt5 = useTerminalSkin();
  // If the user arrived here from a logged-out deposit, reopen that sheet once they're in.
  const resumeAfterAuth = useDepositUi((s) => s.resumeAfterAuth);
  const resumeDeposit = useDepositUi((s) => s.resumeDeposit);

  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [referral, setReferral] = useState('');
  const [showRef, setShowRef] = useState(false);
  const [showPw, setShowPw] = useState(false);
  // Marketers demo the platform on LIVE STREAMS and sign in/up on camera, so the phone field reads
  // as the partial mask 0798****061 at rest and the eye reveals the hidden digits. `phoneFocused`
  // exists because an input renders its own value: while editing it must show the real digits (see
  // phoneDisplay). Nothing functional changes — the real value is what is submitted.
  const [showPhone, setShowPhone] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  // Security-question reset (0097): for a PRIVILEGED phone the reset requires the account's three
  // security answers. `resetKeys` is the (possibly empty) set of question keys the server says this
  // phone must answer; empty ⇒ a normal (player) reset with no extra step. `resetLabels` maps a key
  // to its human question. `resetAnswers` holds the typed answers keyed by question key.
  const [resetKeys, setResetKeys] = useState<string[]>([]);
  const [resetLabels, setResetLabels] = useState<Record<string, string>>({});
  const [resetAnswers, setResetAnswers] = useState<Record<string, string>>({});

  const isRegister = mode === 'register';
  const isReset = mode === 'reset';

  // Prefill a referral code captured by the /r/[code] landing (FE6).
  useEffect(() => {
    if (!open) return;
    try {
      const stored = window.localStorage.getItem(REF_KEY);
      if (stored) {
        setReferral(stored);
        setShowRef(true);
      }
    } catch {
      /* ignore */
    }
  }, [open]);

  // Reset transient state whenever the modal is reopened or the mode flips.
  useEffect(() => {
    setErrors({});
    setServerError(null);
    setShowPw(false);
    setConfirm('');
    setResetDone(false);
    setResetKeys([]);
    setResetAnswers({});
  }, [open, mode]);

  // Load the question labels once when the reset flow opens (needed to render a privileged account's
  // questions by their human wording).
  useEffect(() => {
    if (!open || !isReset) return;
    let active = true;
    api
      .securityQuestionsCatalog()
      .then((r) => {
        if (active) setResetLabels(Object.fromEntries(r.questions.map((q) => [q.key, q.label])));
      })
      .catch(() => {
        /* labels are cosmetic; keys still render if this fails */
      });
    return () => {
      active = false;
    };
  }, [open, isReset]);

  // When a full phone is entered in reset mode, look up which security questions (if any) this
  // account must answer. Debounced. A non-privileged/unknown phone returns an empty set (200), so the
  // normal single-step reset renders unchanged.
  useEffect(() => {
    if (!open || !isReset) {
      setResetKeys([]);
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) {
      setResetKeys([]);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      api
        .resetQuestions({ phone, site: brand.slug })
        .then((r) => {
          if (active) setResetKeys(r.keys);
        })
        .catch(() => {
          if (active) setResetKeys([]);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [open, isReset, phone, brand.slug]);

  // ACCT-1: second step for accounts with two-factor authentication. Declared before the early
  // return below: hooks must run on every render (BUGLOG #79).
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  useEffect(() => { if (!open || mode !== 'login') { setNeedsCode(false); setUseRecovery(false); setCode(''); } }, [open, mode]);

  const copy = useMemo(() => {
    if (isReset) return { title: 'Reset password', sub: '', cta: 'Update password' };
    if (isRegister) return { title: 'Create account', sub: '', cta: 'Create account' };
    return { title: 'Log in', sub: '', cta: 'Log in' };
  }, [isRegister, isReset]);

  if (!open) return null;

  function validate(): boolean {
    // Login sends any password to the server (older passwords may predate today's rules); the rules
    // apply only to a NEW password (register / reset).
    const next: Record<string, string | undefined> = { phone: phoneError(phone), password: isRegister || isReset ? passwordError(password) : (password ? undefined : 'Enter your password.') };
    if (isRegister) {
      next['username'] = usernameError(username);
      next['referral'] = referralError(referral);
    }
    if (isRegister || isReset) {
      next['confirm'] = confirm === password ? undefined : 'Passwords do not match.';
    }
    // Privileged reset: every required security answer must be filled (server verifies correctness).
    if (isReset && resetKeys.length) {
      for (const k of resetKeys) {
        const a = resetAnswers[k];
        next[`ans_${k}`] = a && a.trim().length >= 2 ? undefined : 'Required';
      }
    }
    setErrors(next);
    return !Object.values(next).some(Boolean);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      if (isReset) {
        const answers = resetKeys.map((k) => ({ key: k, answer: resetAnswers[k] ?? '' }));
        await api.resetPassword({
          phone,
          new_password: password,
          site: brand.slug,
          ...(answers.length ? { answers } : {}),
        });
        setResetDone(true);
        return;
      }
      if (isRegister) {
        const body: RegisterInput = { phone, username, password };
        const code = referral.trim();
        if (code) body.referral_code = code.toUpperCase();
        await register(body);
        try {
          window.localStorage.removeItem(REF_KEY);
        } catch {
          /* ignore */
        }
      } else {
        await login(phone, password, needsCode ? (useRecovery ? { recoveryCode: code.trim() } : { totp: code.trim() }) : undefined);
      }
      close();
      if (resumeAfterAuth) resumeDeposit();
    } catch (err) {
      // ACCT-1: an account with two-factor turned on asks for its code after the password.
      const code2 = (err as { code?: string })?.code;
      if (!isRegister && !isReset && code2 === 'MFA_REQUIRED') { setNeedsCode(true); setServerError(null); return; }
      if (code2 === 'MFA_INVALID') { setServerError(useRecovery ? 'That recovery code is not valid.' : 'That code is wrong or expired. Try the newest code in your app.'); return; }
      setServerError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── password updated confirmation ─────────────────────────────────────────── */
  if (isReset && resetDone) {
    return (
      <Modal open={open} onClose={close} title="Password updated" chrome={false} panelStyle={mt5 ? MT5_TOKENS : undefined} panelClassName={mt5 ? 'mt5-square sm:!rounded-sm' : undefined}>
        <Header onClose={close} />
        <div className="flex flex-col items-center gap-3 px-4 pb-8 pt-2 text-center sm:px-6">
          <CheckIcon />
          <h2 className="text-lg font-semibold tracking-tight text-fg">Password updated</h2>
          <p className="max-w-xs text-sm leading-relaxed text-muted">
            Your new password is active. Log in to continue trading.
          </p>
          <Button size="lg" fullWidth className="mt-2 font-semibold" onClick={() => openAuth('login')}>
            Continue to log in
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title={copy.title} chrome={false} panelStyle={mt5 ? MT5_TOKENS : undefined} panelClassName={mt5 ? 'mt5-square sm:!rounded-sm' : undefined}>
      <Header onClose={close} mt5={mt5} title={copy.title} />

      {/* Title block — left aligned, tight hierarchy. MetaTrader's blue bar already carries the
          screen name, so repeating it underneath would say the same thing twice on a phone. */}
      {mt5 ? (
        copy.sub ? <p className="px-4 pb-3 pt-3 text-[13px] text-muted">{copy.sub}</p> : <div className="pt-1" />
      ) : (
        <div className="px-4 pb-4 sm:px-6">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-fg">{copy.title}</h2>
          {copy.sub ? <p className="mt-1 text-sm text-muted">{copy.sub}</p> : null}
        </div>
      )}

      {/* Quiet underline tabs (hidden in reset, which is a sub-flow of log in) */}
      {!isReset ? (
        <div className="px-4 sm:px-6">
          <div className="flex gap-6 border-b border-border" role="tablist" aria-label="Authentication mode">
            {(['login', 'register'] as const).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => openAuth(m)}
                  className={cn(
                    // The underline stays as quiet as before; the padding is what makes the tab a
                    // finger-sized target rather than the height of its own 14px label.
                    '-mb-px border-b-2 px-0.5 pb-3 pt-2.5 text-sm font-semibold transition-colors',
                    active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                  )}
                >
                  {m === 'login' ? 'Log in' : 'Sign up'}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 sm:px-6">
          <button
            type="button"
            onClick={() => openAuth('login')}
            className="-ml-1 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-medium text-muted transition hover:text-fg"
          >
            <BackIcon />
            Back to log in
          </button>
        </div>
      )}

      {/* A 24px gutter either side costs a 320px phone a sixth of its width, which is what pushed
          the field adornments and the "At least 4 characters" placeholder against each other; the
          wider gutter comes back as soon as there is room for it. */}
      <form className="flex flex-col gap-4 px-4 pt-5 sm:px-6" onSubmit={onSubmit} noValidate>
        <Input
          label="Phone number"
          name="phone"
          // Shows the partial mask 0798****061 at rest, the real digits while editing, and the full
          // number when the eye is on (see phoneDisplay). type stays 'tel' so the keypad and autofill
          // behave exactly as before, and `phone` — the real value — is what gets submitted.
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          required
          autoFocus
          placeholder="07XX XXX XXX"
          trailing={
            <button
              type="button"
              onClick={() => setShowPhone((v) => !v)}
              aria-label={showPhone ? 'Hide phone number' : 'Show the hidden digits'}
              className="flex h-10 w-10 items-center justify-center rounded-lg transition hover:bg-border hover:text-fg"
            >
              <EyeIcon off={showPhone} />
            </button>
          }
          value={phoneDisplay(phone, showPhone, phoneFocused)}
          onFocus={() => setPhoneFocused(true)}
          onBlur={() => setPhoneFocused(false)}
          // Guard: the mask is display-only and must never be read back as input. onChange can only
          // see the real value (typing requires focus; autofill supplies real digits), but a stray
          // masked value would have its '*' stripped by localPhone and silently corrupt the number —
          // on the login field. Cheap insurance: ignore anything carrying the mask character.
          onChange={(e) => { if (!isMaskedValue(e.target.value)) setPhone(localPhone(e.target.value)); }}
          error={errors['phone']}
        />

        {isRegister ? (
          <Input
            label="Username"
            name="username"
            autoComplete="username"
            required
            placeholder="Shown on your profile"
            leading={<UserIcon />}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={errors['username']}
          />
        ) : null}

        <div className="flex flex-col gap-1.5">
          {/* Label row carries the inline recovery affordance, as on major exchanges. */}
          {!isRegister && !isReset ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-fg">
                Password<span className="text-down" aria-hidden> *</span>
              </span>
              {/* Negative margins keep the label row visually tight while the recovery link itself
                  carries a full-height hit area. */}
              <button
                type="button"
                onClick={() => openAuth('reset')}
                className="-my-2 -mr-1 inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-1 text-xs font-medium text-accent transition hover:underline"
              >
                Forgot password?
              </button>
            </div>
          ) : null}
          <Input
            label={isRegister ? 'Password' : isReset ? 'New password' : undefined}
            name="password"
            type={showPw ? 'text' : 'password'}
            autoComplete={isRegister || isReset ? 'new-password' : 'current-password'}
            required
            placeholder={isRegister || isReset ? 'At least 4 characters' : '••••'}
            leading={<LockIcon />}
            trailing={
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="flex h-10 w-10 items-center justify-center rounded-lg transition hover:bg-border hover:text-fg"
              >
                <EyeIcon off={showPw} />
              </button>
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors['password']}
          />
          {isRegister || isReset ? <StrengthMeter password={password} /> : null}
        </div>

        {isRegister || isReset ? (
          <Input
            label="Confirm password"
            name="confirm"
            type={showPw ? 'text' : 'password'}
            autoComplete="new-password"
            required
            placeholder="Re-enter your password"
            leading={<LockIcon />}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors['confirm']}
          />
        ) : null}

        {/* Privileged (admin) reset: answer the account's security questions as a second factor (0097). */}
        {isReset && resetKeys.length ? (
          <div className="flex flex-col gap-3 rounded-brand border border-border bg-surface-2/40 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
              <span className="text-up">
                <ShieldIcon />
              </span>
              <span>Admin account: verify your security questions</span>
            </div>
            {resetKeys.map((k) => (
              <Input
                key={k}
                label={resetLabels[k] ?? k}
                name={`ans_${k}`}
                autoComplete="off"
                placeholder="Your answer"
                value={resetAnswers[k] ?? ''}
                onChange={(e) => setResetAnswers((prev) => ({ ...prev, [k]: e.target.value }))}
                error={errors[`ans_${k}`]}
              />
            ))}
            <p className="text-[11px] leading-relaxed text-muted">Matching is case-insensitive.</p>
          </div>
        ) : null}

        {/* Referral stays collapsed so the default signup path is two fields, not four. */}
        {isRegister ? (
          showRef ? (
            <Input
              label="Referral code"
              name="referral"
              optional
              placeholder="8-character code"
              leading={<TagIcon />}
              value={referral}
              onChange={(e) => setReferral(e.target.value.toUpperCase())}
              error={errors['referral']}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowRef(true)}
              className="-my-1.5 -ml-1 inline-flex min-h-11 items-center self-start px-1 text-xs font-medium text-muted transition hover:text-accent"
            >
              + Add a referral code
            </button>
          )
        ) : null}

        {serverError ? (
          <p
            className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-down"
            role="alert"
          >
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="8" x2="12" y2="13" strokeLinecap="round" />
              <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
            </svg>
            <span className="min-w-0 break-words">{serverError}</span>
          </p>
        ) : null}

        {needsCode && !isRegister && !isReset ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <Input
              label={useRecovery ? 'Recovery code' : 'Authentication code'}
              name="totp"
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoFocus
              placeholder={useRecovery ? 'XXXX-XXXX' : '123456'}
              value={code}
              onChange={(e) => setCode(useRecovery ? e.target.value.slice(0, 32) : e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            />
            <p className="text-xs text-muted">{useRecovery ? 'Use one of the recovery codes you saved when you turned on two-factor.' : 'Two-factor is on for this account. Enter the 6-digit code from your authenticator app.'}</p>
            <button type="button" onClick={() => { setUseRecovery((v) => !v); setCode(''); }} className="-ml-1 inline-flex min-h-11 items-center self-start px-1 text-left text-xs font-medium text-accent hover:underline">
              {useRecovery ? 'Use the app code instead' : 'Lost your phone? Use a recovery code'}
            </button>
          </div>
        ) : null}

        <Button type="submit" size="lg" fullWidth disabled={busy} className="mt-1 font-semibold">
          {busy ? (
            <>
              <Spinner />
              Please wait…
            </>
          ) : (
            copy.cta
          )}
        </Button>

        {/* Mode cross-link keeps the tabs from being the only path between states. */}
        {!isReset ? (
          <p className="pb-1 text-center text-sm text-muted">
            {isRegister ? 'Have an account?' : `New to ${brand.name}?`}{' '}
            <button
              type="button"
              onClick={() => openAuth(isRegister ? 'login' : 'register')}
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 align-middle font-semibold text-accent transition hover:underline"
            >
              {isRegister ? 'Log in' : 'Create one'}
            </button>
          </p>
        ) : null}
      </form>

      {/* Trust + legal footer */}
      <div className="mt-2 flex flex-col gap-2.5 border-t border-border px-4 py-5 sm:px-6">
        <div className="flex items-center justify-center gap-1.5 text-xs text-muted">
          <span className="text-up">
            <ShieldIcon />
          </span>
          <span>M-Pesa · 18+</span>
        </div>
        <p className="text-center text-xs leading-relaxed text-muted">
          By continuing you agree to our{' '}
          <Link href="/legal" onClick={close} className="font-medium text-fg underline-offset-2 hover:underline">
            Terms &amp; Responsible Gaming
          </Link>{' '}
          policy.
        </p>
      </div>
    </Modal>
  );
}

/** Compact brand row with the dismiss control. */
function Header({ onClose, mt5, title }: { onClose: () => void; mt5?: boolean; title?: string }) {
  // MetaTrader titles a screen with a solid blue band carrying the screen's own name — see its
  // "Login to an account" screen. The brand lockup and the theme toggle belong to the site's own
  // header, not to MetaTrader's.
  if (mt5) {
    return (
      <div className="flex items-center gap-3 border-b border-[var(--mt5-border)] bg-[var(--mt5-blue)] px-3 py-2.5">
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight text-white">{title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 grid h-10 w-10 shrink-0 place-items-center rounded text-white transition hover:bg-white/20"
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
            <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 px-4 pb-5 pt-5 sm:px-6">
      <Logo />
      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
            <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
