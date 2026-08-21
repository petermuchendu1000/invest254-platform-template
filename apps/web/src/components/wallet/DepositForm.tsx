'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, formatKes, kesToCents } from '@invest254/shared/money';
import { normalizeMsisdn, MIN_DEPOSIT_CENTS } from '@invest254/shared/payments';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import { useDeposit, useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { authErrorMessage } from '@/lib/auth/errors';
import { maskMsisdn } from '@/lib/wallet/format';

/** Common top-up amounts (KES). One tap beats typing on mobile (NN/g: match input to data). */
const QUICK_KES = [200, 500, 1000, 5000] as const;
const MIN_KES = centsToKes(MIN_DEPOSIT_CENTS);

const digitsOnly = (s: string) => s.replace(/\D/g, '');
const grouped = (s: string) => (s ? Number(s).toLocaleString('en-KE') : '');

/** Deposit body for the unified wallet sheet (no Modal/header — WalletModal provides those). */
export function DepositForm() {
  const close = useDepositUi((s) => s.close);
  const prefillAmountCents = useDepositUi((s) => s.prefillAmountCents);
  const pending = useDepositUi((s) => s.pending);
  const deferToAuth = useDepositUi((s) => s.deferToAuth);
  const openAuth = useAuthUi((s) => s.openAuth);

  const token = useSession((s) => s.token);
  const accountPhone = useSession((s) => s.user?.phone ?? null);
  const { data: wallet } = useWallet();
  const deposit = useDeposit();

  const [amount, setAmount] = useState(() =>
    prefillAmountCents && prefillAmountCents > 0 ? String(Math.ceil(centsToKes(prefillAmountCents))) : '200',
  );
  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [txId, setTxId] = useState<string | null>(null);
  const balanceAtSubmitRef = useRef<number>(0);

  // While the STK callback settles, poll THIS deposit's status so the sheet can react the
  // instant M-Pesa confirms (success) or rejects/expires (failed) — no manual "Done" tap.
  const { data: depositTx } = useQuery({
    queryKey: ['deposit-status', txId],
    enabled: done && !!txId && !!token,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | null | undefined)?.status;
      return s === 'success' || s === 'failed' ? false : 3000;
    },
    queryFn: async () => {
      const page = await api.transactions(token as string, { kind: 'deposit' });
      return page.items.find((t) => t.id === txId) ?? null;
    },
  });

  const balanceNow = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
  // Success = the tx flipped to success OR the polled balance rose above the pre-deposit total.
  const settled = done && (depositTx?.status === 'success' || balanceNow > balanceAtSubmitRef.current);
  const failed = done && !settled && depositTx?.status === 'failed';

  // Auto-dismiss shortly after a confirmed deposit (long enough to show the success tick).
  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => close(), 1800);
    return () => clearTimeout(t);
  }, [settled, close]);

  const intentLabel = pending ? (pending.direction === 'buy' ? 'BUY' : 'SELL') : null;
  const effectivePhone = editingPhone || !accountPhone ? phone : accountPhone;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const kes = Number(amount);
    const next: Record<string, string | undefined> = {};
    if (!Number.isInteger(kes) || kes < MIN_KES) next['amount'] = `Enter at least ${formatKes(MIN_DEPOSIT_CENTS)}.`;
    // Logged-out users only pick an amount here; the phone comes from their account after sign up.
    if (token) {
      try {
        normalizeMsisdn(effectivePhone);
      } catch {
        next['phone'] = 'Enter a valid Kenyan number, e.g. 0712 345 678.';
      }
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    // Business logic first: capture the amount, route to sign up/login, then resume this deposit.
    if (!token) {
      deferToAuth(kesToCents(kes));
      openAuth('register');
      return;
    }
    try {
      balanceAtSubmitRef.current = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
      const res = await deposit.mutateAsync({ amount: kesToCents(kes), phone: effectivePhone });
      setTxId(res.transactionId);
      setDone(true);
    } catch (err) {
      setServerError(authErrorMessage(err));
    }
  }

  if (settled) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <SuccessTick />
        <h3 className="text-base font-semibold text-fg">Deposit received</h3>
        <p className="text-sm text-muted">
          {formatKes(kesToCents(Number(amount)))} has been added to your wallet.
        </p>
        <p className="text-xs text-muted">
          {intentLabel ? `Your ${intentLabel} trade is ready.` : 'Closing…'}
        </p>
        <Button fullWidth onClick={close}>Done</Button>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <FailX />
        <h3 className="text-base font-semibold text-fg">Payment not completed</h3>
        <p className="text-sm text-muted">
          The M-Pesa prompt wasn’t approved in time or was cancelled. No money was deducted.
        </p>
        <Button fullWidth onClick={() => { setDone(false); setTxId(null); }}>Try again</Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <Spinner />
        <h3 className="text-base font-semibold text-fg">Check your phone</h3>
        <p className="text-sm text-muted">
          We sent a prompt to <span className="font-medium text-fg">{maskMsisdn(normalizeMsisdn(effectivePhone))}</span>.
          Enter your M-Pesa PIN to approve {formatKes(kesToCents(Number(amount)))}.
        </p>
        <p className="text-xs text-muted">
          {intentLabel
            ? `This updates automatically — your ${intentLabel} trade will be ready the moment the deposit lands.`
            : 'This screen updates automatically once M-Pesa confirms — no need to refresh.'}
        </p>
        <Button variant="ghost" fullWidth onClick={close}>Cancel</Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4 p-4" onSubmit={onSubmit} noValidate>
      {/* Quick amounts */}
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {QUICK_KES.map((q) => {
          const active = Number(amount) === q;
          return (
            <button
              key={q}
              type="button"
              onClick={() => { setAmount(String(q)); setErrors((p) => ({ ...p, amount: undefined })); }}
              className={[
                'shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition',
                active ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface-2 text-fg hover:border-accent/60',
              ].join(' ')}
            >
              {grouped(String(q))}
            </button>
          );
        })}
      </div>

      {/* Hero amount field: text + numeric inputmode (avoids number-spinner UX bugs) */}
      <Input
        label="Amount (KES)"
        name="amount"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        required
        leading={<span className="text-sm font-semibold text-muted">KES</span>}
        value={grouped(amount)}
        onChange={(e) => setAmount(digitsOnly(e.target.value))}
        error={errors['amount']}
        hint={`Minimum ${formatKes(MIN_DEPOSIT_CENTS)}`}
        className="text-lg font-semibold"
      />

      {/* Deposit-bonus preview removed: the only bonus in the system is the sign-up welcome bonus
          (see docs/31). Deposit bonuses are not granted, so we no longer advertise one here. */}

      {/* M-Pesa number: only collected once signed in (prefilled from the account, read-only unless changed) */}
      {token ? (
        accountPhone && !editingPhone ? (
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3.5 py-3">
          <div>
            <div className="text-xs text-muted">M-Pesa number</div>
            <div className="text-sm font-medium text-fg">{maskMsisdn(accountPhone)}</div>
          </div>
          <button
            type="button"
            onClick={() => { setEditingPhone(true); setPhone(''); }}
            className="text-sm font-semibold text-accent hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <Input
          label="M-Pesa number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="0712 345 678"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors['phone']}
          {...(accountPhone ? { hint: 'Sending to a different number than your account.' } : {})}
        />
        )
      ) : null}

      {serverError ? (
        <p className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm text-down" role="alert">
          {serverError}
        </p>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        {token
          ? 'You’ll get an STK push prompt on your phone — enter your M-Pesa PIN to confirm. Your PIN is never entered in this app.'
          : 'Create your free account next, then approve the M-Pesa prompt to fund this deposit.'}
      </p>
      <Button type="submit" size="lg" fullWidth disabled={deposit.isPending}>
        {!token
          ? 'Sign up to deposit'
          : deposit.isPending
            ? 'Sending STK push…'
            : 'Continue to M-Pesa'}
      </Button>
    </form>
  );
}

function Spinner() {
  return (
    <svg className="h-10 w-10 animate-spin text-accent" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SuccessTick() {
  return (
    <svg className="h-10 w-10 text-accent" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <path d="M7 12.5l3.2 3.2L17 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FailX() {
  return (
    <svg className="h-10 w-10 text-danger" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
