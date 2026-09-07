'use client';

import { useEffect, useState } from 'react';
import { formatKes } from '@invest254/shared/money';
import { Button } from '@/components/ui/Button';
import { usePaybillInfo, useClaimPaybill } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';

/**
 * Manual "Lipa na M-PESA · Pay Bill" deposit. The player pays our Pay Bill from the M-PESA menu,
 * then pastes the confirmation code here; the server credits the EXACT amount Safaricom recorded
 * (verified via C2B), so nothing entered on this screen can inflate a deposit. Copy targets are
 * one-tap because typing a paybill/account on a phone keypad is the biggest drop-off point.
 */
export function PayBillDeposit() {
  const close = useDepositUi((s) => s.close);
  const openAuth = useAuthUi((s) => s.openAuth);
  const deferToAuth = useDepositUi((s) => s.deferToAuth);
  const token = useSession((s) => s.token);
  const { data: info, isLoading } = usePaybillInfo();
  const claim = useClaimPaybill();

  const [code, setCode] = useState('');
  const [credited, setCredited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false); // Safaricom hasn't confirmed yet

  useEffect(() => {
    if (credited === null) return;
    const t = setTimeout(() => close(), 2200);
    return () => clearTimeout(t);
  }, [credited, close]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(false);
    const c = code.trim().toUpperCase();
    if (c.length < 6) { setError('Enter the full M-PESA confirmation code from your SMS.'); return; }
    if (!token) { deferToAuth(); openAuth('register'); return; }
    try {
      const res = await claim.mutateAsync({ code: c });
      if (res.status === 'credited' || res.status === 'already_claimed') {
        setCredited(res.amountCents ?? 0);
      } else {
        setPending(true); // not_found — confirmation may lag a few seconds
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CODE_ALREADY_USED')) setError('This code has already been used on another account.');
      else setError('We couldn’t verify that code. Check it and try again.');
    }
  }

  if (credited !== null) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <SuccessTick />
        <h3 className="text-base font-semibold text-fg">Deposit received</h3>
        <p className="text-sm text-muted">{formatKes(credited)} has been added to your wallet.</p>
        <Button fullWidth onClick={close}>Done</Button>
      </div>
    );
  }

  return (
    <form className="mx-auto flex w-full max-w-sm flex-col gap-4 px-5 pb-6 pt-4" onSubmit={onSubmit} noValidate>
      {/* Pay Bill card — one-tap copy for every value */}
      <div className="overflow-hidden rounded-2xl bg-up text-white shadow-sm">
        <div className="flex items-center justify-between px-4 pt-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-white/70">Safaricom</div>
            <div className="text-lg font-bold leading-tight">Lipa na M-PESA · Pay Bill</div>
          </div>
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-lg">📲</span>
        </div>
        <div className="flex flex-col gap-2.5 p-4">
          <CopyRow label="Business number (Pay Bill)" value={info?.shortcode ?? ''} loading={isLoading} />
          <CopyRow label="Account number" value={info?.accountNumber ?? ''} loading={isLoading} />
        </div>
        <div className="border-t border-white/15 px-4 py-2.5 text-xs text-white/80">
          Recipient: <span className="font-semibold text-white">{info?.businessName || '—'}</span>
        </div>
      </div>

      {/* How to pay — condensed */}
      <ol className="flex flex-col gap-1.5 text-sm text-muted">
        <Step n={1}>Open M-PESA → <span className="font-medium text-fg">Lipa na M-PESA</span> → <span className="font-medium text-fg">Pay Bill</span>.</Step>
        <Step n={2}>Business no. <span className="font-semibold text-fg">{info?.shortcode ?? '—'}</span>, Account <span className="font-semibold text-fg">{info?.accountNumber ?? '—'}</span>.</Step>
        <Step n={3}>Enter the amount and your M-PESA PIN to pay.</Step>
        <Step n={4}>Paste the confirmation code from the M-PESA SMS below.</Step>
      </ol>

      {/* Confirmation code */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="mpesa-code" className="text-sm font-medium text-fg">M-PESA transaction code</label>
        <input
          id="mpesa-code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="e.g. TJ84KD9P2L"
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null); setPending(false); }}
          className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-3 font-mono text-lg uppercase tracking-wide text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <p className="text-xs text-muted">Paste it exactly as it appears in the SMS. Deposits are verified against Safaricom records before your account is credited.</p>
      </div>

      {error ? (
        <p className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm text-down" role="alert">{error}</p>
      ) : null}
      {pending ? (
        <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" role="status">
          We haven’t received this payment from Safaricom yet. Give it a few seconds, then tap Verify again.
        </p>
      ) : null}

      <Button type="submit" size="lg" fullWidth disabled={claim.isPending}>
        {!token ? 'Sign up to deposit' : claim.isPending ? 'Verifying…' : pending ? 'Verify again' : 'Verify & credit'}
      </Button>
    </form>
  );
}

function CopyRow({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable — value is visible to type manually */ }
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-white/10 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wider text-white/70">{label}</div>
        <div className="font-mono text-lg font-bold tabular-nums text-white">{loading ? '···' : (value || '—')}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/25"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-up/15 text-[11px] font-bold text-up">{n}</span>
      <span>{children}</span>
    </li>
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
