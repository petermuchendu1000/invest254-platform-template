'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { kesToCents, centsToKes, formatKes } from '@invest254/shared/money';
import { normalizeMsisdn, MIN_WITHDRAWAL_CENTS } from '@invest254/shared/payments';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import { useWithdraw, useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useSession } from '@/lib/auth/session';
import { authErrorMessage } from '@/lib/auth/errors';
import { maskMsisdn } from '@/lib/wallet/format';
import { useBrand } from '@/lib/brand/BrandProvider';

const digitsOnly = (s: string) => s.replace(/\D/g, '');
const grouped = (s: string) => (s ? Number(s).toLocaleString('en-KE') : '');

function MpesaIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 3v18" strokeOpacity="0" />
      <path d="M12 7v6M9.5 9h4a1.5 1.5 0 010 3h-2.5a1.5 1.5 0 000 3H14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckCircle() {
  return (
    <svg viewBox="0 0 24 24" className="h-14 w-14 text-up" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="10" opacity="0.3" />
      <path d="M7 12.5l3.2 3.2L17 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Withdraw body for the unified wallet sheet (no Modal/header — WalletModal provides those). */
export function WithdrawForm() {
  const close = useDepositUi((s) => s.close);
  const { data: wallet } = useWallet();
  const accountPhone = useSession((s) => s.user?.phone ?? null);
  const withdraw = useWithdraw();

  // Live minimum withdrawal from game config (admin-editable). Falls back to the shared
  // constant so the form still validates sensibly before config loads / if the fetch fails.
  const brand = useBrand();
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });
  const minWithdrawalCents = config?.minWithdrawalCents ?? MIN_WITHDRAWAL_CENTS;
  const minKes = centsToKes(minWithdrawalCents);

  const [amount, setAmount] = useState('');
  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [paid, setPaid] = useState(false);
  const [paidAmountKes, setPaidAmountKes] = useState(0);

  const realCents = wallet?.real ?? 0;
  const effectivePhone = editingPhone || !accountPhone ? phone : accountPhone;

  const kes = Number(amount);
  const amountCents = Number.isFinite(kes) ? kesToCents(kes) : 0;
  const amountValid = Number.isInteger(kes) && kes >= minKes && amountCents <= realCents;
  const destMasked = useMemo(() => {
    try {
      return maskMsisdn(normalizeMsisdn(effectivePhone));
    } catch {
      return effectivePhone ? effectivePhone : '—';
    }
  }, [effectivePhone]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const next: Record<string, string | undefined> = {};
    if (!Number.isInteger(kes) || kes < minKes) next['amount'] = `Minimum withdrawal is ${formatKes(minWithdrawalCents)}.`;
    else if (kesToCents(kes) > realCents) next['amount'] = 'Amount exceeds your real balance.';
    try {
      normalizeMsisdn(effectivePhone);
    } catch {
      next['phone'] = 'Enter a valid Kenyan number, e.g. 0712 345 678.';
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    try {
      const res = await withdraw.mutateAsync({ amount: kesToCents(kes), phone: effectivePhone });
      setPaid(Boolean(res?.paid));
      setPaidAmountKes(kes);
      setDone(true);
    } catch (err) {
      setServerError(authErrorMessage(err));
    }
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
        <CheckCircle />
        <div>
          <h3 className="text-lg font-bold text-fg">
            {paid ? 'Sent to M-Pesa' : 'Withdrawal requested'}
          </h3>
          <p className="mt-1 text-sm text-muted">
            {paid
              ? 'It reflects in your M-Pesa balance instantly.'
              : 'Funds are held and paid out after approval.'}
          </p>
        </div>
        <div className="w-full max-w-xs rounded-2xl border border-border bg-surface-2 p-4">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-muted">Amount</span>
            <span className="text-sm font-bold tabular-nums text-fg">{formatKes(kesToCents(paidAmountKes))}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-muted">To</span>
            <span className="text-sm font-medium tabular-nums text-fg">{destMasked}</span>
          </div>
        </div>
        <Button fullWidth size="lg" onClick={close}>Done</Button>
      </div>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────────────
  return (
    <form className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-5 pb-6 pt-4" onSubmit={onSubmit} noValidate>
      {/* Amount hero — centered entry, the focal point of the form. */}
      <div
        className={[
          'rounded-2xl border bg-surface-2 px-4 py-5 text-center transition',
          errors['amount'] ? 'border-down' : 'border-border focus-within:border-accent',
        ].join(' ')}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Amount to withdraw</span>
        <div className="mt-2 flex items-baseline justify-center gap-1.5">
          <span className="text-2xl font-bold text-muted">KES</span>
          <input
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-label="Amount to withdraw in KES"
            placeholder="0"
            value={grouped(amount)}
            onChange={(e) => { setAmount(digitsOnly(e.target.value)); setErrors((p) => ({ ...p, amount: undefined })); }}
            style={{ width: `${Math.max(1, (grouped(amount) || '0').length)}ch` }}
            className="max-w-full bg-transparent text-4xl font-black tabular-nums text-fg outline-none placeholder:text-muted"
          />
        </div>
      </div>
      <p className="-mt-1 text-center text-xs text-muted">Min {formatKes(minWithdrawalCents)}</p>
      {errors['amount'] ? <p className="text-center text-xs text-down">{errors['amount']}</p> : null}

      {/* Destination */}
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
            {...(accountPhone
              ? { hint: 'Paying out to a different number than your account.' }
              : { hint: 'Funds are sent to this M-Pesa number.' })}
          />
        )}
      </div>

      {/* Payout summary — appears once the amount is valid. */}
      {amountValid ? (
        <div className="rounded-xl border border-border bg-surface-2 p-3.5">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-muted">You’ll receive</span>
            <span className="text-base font-bold tabular-nums text-up">{formatKes(amountCents)}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-muted">To M-Pesa</span>
            <span className="text-sm font-medium tabular-nums text-fg">{destMasked}</span>
          </div>
        </div>
      ) : null}

      {serverError ? (
        <p className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm text-down" role="alert">
          {serverError}
        </p>
      ) : null}

      <Button type="submit" size="lg" fullWidth disabled={withdraw.isPending || !amountValid}>
        {withdraw.isPending ? 'Requesting…' : amountValid ? `Withdraw ${formatKes(amountCents)}` : 'Withdraw'}
      </Button>

      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" />
          <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Paid instantly to M-Pesa · Secured
      </p>
    </form>
  );
}
