'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, formatKes, kesToCents } from '@invest254/shared/money';
import { normalizeMsisdn, MIN_DEPOSIT_CENTS } from '@invest254/shared/payments';
import { useDisplayMoney, USD_LIMITS } from '@/lib/money';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import { useDeposit, useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { authErrorMessage } from '@/lib/auth/errors';
import { maskMsisdn } from '@/lib/wallet/format';
import { MpesaIcon } from '@/components/wallet/MpesaIcon';

/** Common top-up amounts (KES). One tap beats typing on mobile (NN/g: match input to data). */

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
  const { fmt, both, symbol, isForeign, toKesCents, toDisplay, limit, currency } = useDisplayMoney();
  // Foreign brands enter in the display currency (e.g. USD); KES brands enter whole KES. Decimals
  // are allowed only for foreign entry. All validation + the API call use authoritative KES cents.
  const sanitizeAmount = (v: string) => (isForeign ? v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1') : digitsOnly(v));

  const [amount, setAmount] = useState(() => {
    if (prefillAmountCents && prefillAmountCents > 0) {
      return isForeign ? String(Math.ceil(toDisplay(prefillAmountCents) * 100) / 100) : String(Math.ceil(centsToKes(prefillAmountCents)));
    }
    return isForeign ? '10' : '200';
  });
  const parsedAmount = Number.parseFloat(amount);
  const amountKesCents = isForeign
    ? (Number.isFinite(parsedAmount) && parsedAmount > 0 ? toKesCents(parsedAmount) : 0)
    : (Number.isInteger(Number(amount)) ? kesToCents(Number(amount)) : 0);
  // Quick amounts in the entry unit: $5/$10/$50/$100 for foreign brands, KES presets otherwise.
  const quick = isForeign ? [5, 10, 50, 100] : [200, 500, 1000, 5000];
  // Foreign brands: USD-native minimum ($5) converted to KES, never below the platform's KES floor.
  const minDepositCents = limit(USD_LIMITS.minDeposit, MIN_DEPOSIT_CENTS);
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
    const next: Record<string, string | undefined> = {};
    if (!Number.isInteger(amountKesCents) || amountKesCents < minDepositCents) next['amount'] = `Enter at least ${both(minDepositCents)}.`;
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
      deferToAuth(amountKesCents);
      openAuth('register');
      return;
    }
    try {
      balanceAtSubmitRef.current = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
      const res = await deposit.mutateAsync({ amount: amountKesCents, phone: effectivePhone });
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
          {fmt(amountKesCents)} has been added to your wallet.
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
          Enter your M-Pesa PIN to approve {formatKes(amountKesCents)}.
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
    <form className="mx-auto flex w-full max-w-sm flex-col gap-4 px-5 pb-6 pt-4" onSubmit={onSubmit} noValidate>
      {/* Amount hero — centered entry, matching the Withdraw sheet. */}
      <div
        className={[
          'rounded-2xl border bg-surface-2 px-4 py-5 text-center transition',
          errors['amount'] ? 'border-down' : 'border-border focus-within:border-accent',
        ].join(' ')}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Amount to deposit</span>
        <div className="mt-2 flex items-baseline justify-center gap-1.5">
          <span className="text-2xl font-bold text-muted">{symbol}</span>
          <input
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-label={`Amount to deposit in ${currency}`}
            placeholder="0"
            value={isForeign ? amount : grouped(amount)}
            onChange={(e) => { setAmount(sanitizeAmount(e.target.value)); setErrors((p) => ({ ...p, amount: undefined })); }}
            style={{ width: `${Math.max(1, ((isForeign ? amount : grouped(amount)) || '0').length)}ch` }}
            className="max-w-full bg-transparent text-4xl font-black tabular-nums text-fg outline-none placeholder:text-muted"
          />
        </div>
      </div>

      {/* Quick amount presets — same segmented treatment as the Withdraw percentage chips. */}
      <div className="-mt-1 grid grid-cols-4 gap-2">
        {quick.map((q) => {
          const active = Number(amount) === q;
          return (
            <button
              key={q}
              type="button"
              onClick={() => { setAmount(String(q)); setErrors((p) => ({ ...p, amount: undefined })); }}
              aria-pressed={active}
              className={[
                'rounded-lg border px-2 py-2 text-sm font-semibold tabular-nums transition',
                active ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface-2 text-fg hover:border-accent/60',
              ].join(' ')}
            >
              {isForeign ? `${symbol}${q}` : grouped(String(q))}
            </button>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted">
        Min {both(minDepositCents)}{isForeign && amountKesCents > 0 ? ` · ≈ ${formatKes(amountKesCents)} via M-Pesa` : ''}
      </p>
      {errors['amount'] ? <p className="text-center text-xs text-down">{errors['amount']}</p> : null}

      {/* M-Pesa number: only collected once signed in (prefilled from the account, read-only unless changed) */}
      {token ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg">M-Pesa number</span>
          {accountPhone && !editingPhone ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-up/15 text-up">
                <MpesaIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tabular-nums text-fg">{maskMsisdn(accountPhone)}</div>
                <div className="text-xs text-muted">Your account number</div>
              </div>
              <button
                type="button"
                onClick={() => { setEditingPhone(true); setPhone(''); }}
                className="shrink-0 text-sm font-semibold text-accent hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="0712 345 678"
              leading={<MpesaIcon />}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={errors['phone']}
              {...(accountPhone ? { hint: 'Sending to a different number than your account.' } : {})}
            />
          )}
        </div>
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
