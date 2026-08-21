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
import { cn } from '@/lib/cn';
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

export function AuthModal() {
  const { open, mode, openAuth, close } = useAuthUi();
  const { login, register } = useAuthActions();
  const brand = useBrand();
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

  const copy = useMemo(() => {
    if (isReset) return { title: 'Reset password', sub: 'Set a new password for your account.', cta: 'Update password' };
    if (isRegister) return { title: 'Create account', sub: 'Start trading in under a minute.', cta: 'Create account' };
    return { title: 'Log in', sub: 'Welcome back. Trade the curve.', cta: 'Log in' };
  }, [isRegister, isReset]);

  if (!open) return null;

  function validate(): boolean {
    const next: Record<string, string | undefined> = { phone: phoneError(phone), password: passwordError(password) };
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
        await login(phone, password);
      }
      close();
      if (resumeAfterAuth) resumeDeposit();
    } catch (err) {
      setServerError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── password updated confirmation ─────────────────────────────────────────── */
  if (isReset && resetDone) {
    return (
      <Modal open={open} onClose={close} title="Password updated">
        <Header onClose={close} />
        <div className="flex flex-col items-center gap-3 px-6 pb-8 pt-2 text-center">
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
    <Modal open={open} onClose={close} title={copy.title}>
      <Header onClose={close} />

      {/* Title block — left aligned, tight hierarchy */}
      <div className="px-6 pb-4">
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-fg">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted">{copy.sub}</p>
      </div>

      {/* Quiet underline tabs (hidden in reset, which is a sub-flow of log in) */}
      {!isReset ? (
        <div className="px-6">
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
                    '-mb-px border-b-2 pb-2.5 text-sm font-semibold transition-colors',
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
        <div className="px-6">
          <button
            type="button"
            onClick={() => openAuth('login')}
            className="inline-flex items-center gap-1 text-sm font-medium text-muted transition hover:text-fg"
          >
            <BackIcon />
            Back to log in
          </button>
        </div>
      )}

      <form className="flex flex-col gap-4 px-6 pt-5" onSubmit={onSubmit} noValidate>
        <Input
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          required
          autoFocus
          placeholder="07XX XXX XXX"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
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
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-fg">
                Password<span className="text-down" aria-hidden> *</span>
              </span>
              <button
                type="button"
                onClick={() => openAuth('reset')}
                className="text-xs font-medium text-accent transition hover:underline"
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
            placeholder={isRegister || isReset ? 'At least 8 characters' : '••••••••'}
            leading={<LockIcon />}
            trailing={
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-border hover:text-fg"
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
              <span>Admin account — verify your security questions</span>
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
              className="self-start text-xs font-medium text-muted transition hover:text-accent"
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
            <span>{serverError}</span>
          </p>
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
            {isRegister ? 'Already have an account?' : 'New to Invest254?'}{' '}
            <button
              type="button"
              onClick={() => openAuth(isRegister ? 'login' : 'register')}
              className="font-semibold text-accent transition hover:underline"
            >
              {isRegister ? 'Log in' : 'Create one'}
            </button>
          </p>
        ) : null}
      </form>

      {/* Trust + legal footer */}
      <div className="mt-2 flex flex-col gap-2.5 border-t border-border px-6 py-5">
        <div className="flex items-center justify-center gap-1.5 text-xs text-muted">
          <span className="text-up">
            <ShieldIcon />
          </span>
          <span>Encrypted in transit · M-Pesa secured · 18+</span>
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
function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-6 pb-5 pt-5">
      <Logo />
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
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
