'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, formatKes, kesToCents } from '@invest254/shared/money';
import { MIN_DEPOSIT_CENTS } from '@invest254/shared/payments';
import { useDisplayMoney, USD_LIMITS } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import { useDepositLipwa, useDepositPayx } from '@/lib/wallet/hooks';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { paymentErrorMessage } from '@/lib/wallet/errors';

const digitsOnly = (s: string) => s.replace(/\D/g, '');
const grouped = (s: string) => (s ? Number(s).toLocaleString('en-KE') : '');

/**
 * PayHero **Lipwa** deposit — card, bank, and any-country mobile money, all IN-APP. We never handle
 * card data: the payment fields render inside an embedded PayHero (PCI-hosted) checkout that slides
 * up as a modal within the wallet sheet, so the player never leaves the app. On success the ledger
 * reconcile credits the wallet and this sheet — which polls THIS deposit's status — flips to a tick.
 *
 * PayX reuses this body for the methods it CANNOT push directly (card, bank, anything whose inputs the
 * collection API has no field for). Those finish on the gateway's own page, embedded here so the player
 * never leaves the app. Methods PayX can push — anything needing only a phone/email — go through
 * DepositForm instead and show no third-party page at all (docs/53).
 */
export function LipwaDeposit({ rail = 'lipwa', methodCode }: { rail?: 'lipwa' | 'payx'; methodCode?: string } = {}) {
  const close = useDepositUi((s) => s.close);
  const prefillAmountCents = useDepositUi((s) => s.prefillAmountCents);
  const deferToAuth = useDepositUi((s) => s.deferToAuth);
  const openAuth = useAuthUi((s) => s.openAuth);
  const token = useSession((s) => s.token);
  const lipwa = useDepositLipwa();
  const payx = useDepositPayx();
  const submitting = rail === 'payx' ? payx.isPending : lipwa.isPending;
  const brand = useBrand();

  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });
  const { fmt, both, symbol, isForeign, toKesCents, toDisplay, limit, currency } = useDisplayMoney();

  // A foreign brand with an operator-set native floor (min_deposit_native) enforces it directly at the
  // live rate, matching the server; otherwise the site KES floor, USD-limit-guarded. Mirrors DepositForm.
  const nativeMinDeposit = config?.minDepositNative ?? null;
  const minDepositCents = (isForeign && nativeMinDeposit != null && nativeMinDeposit > 0)
    ? toKesCents(nativeMinDeposit)
    : limit(USD_LIMITS.minDeposit, config?.minDepositCents ?? MIN_DEPOSIT_CENTS);
  const maxDepositCents = config?.maxDepositCents ?? null;
  const minEntry = isForeign ? toDisplay(minDepositCents) : centsToKes(minDepositCents);
  const chipBase = Math.max(1, isForeign ? Math.round(minEntry * 100) / 100 : Math.ceil(minEntry));
  const quick = [1, 2, 5, 10].map((m) => (isForeign ? Math.round(chipBase * m * 100) / 100 : Math.round(chipBase * m)));

  const sanitizeAmount = (v: string) => (isForeign ? v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1') : digitsOnly(v));
  const [touched, setTouched] = useState(false);
  const [amount, setAmount] = useState(() => {
    if (prefillAmountCents && prefillAmountCents > 0) {
      const c = Math.max(prefillAmountCents, minDepositCents);
      return isForeign ? String(Math.ceil(toDisplay(c) * 100) / 100) : String(Math.ceil(centsToKes(c)));
    }
    return String(chipBase);
  });
  useEffect(() => { if (!touched && !(prefillAmountCents && prefillAmountCents > 0)) setAmount(String(chipBase)); }, [chipBase, touched, prefillAmountCents]);

  const parsed = Number.parseFloat(amount);
  const amountKesCents = isForeign
    ? (Number.isFinite(parsed) && parsed > 0 ? toKesCents(parsed) : 0)
    : (Number.isInteger(Number(amount)) ? kesToCents(Number(amount)) : 0);

  const [amountError, setAmountError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<{ url: string; txId: string } | null>(null);

  // Poll THIS deposit's status while the embedded checkout is open, so we flip to success the instant
  // the ledger reconcile credits it — no manual "Done".
  const { data: depositTx } = useQuery({
    queryKey: ['lipwa-deposit-status', checkout?.txId],
    enabled: !!checkout?.txId && !!token,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | null | undefined)?.status;
      return s === 'success' || s === 'failed' ? false : 3500;
    },
    queryFn: async () => {
      const page = await api.transactions(token as string, { kind: 'deposit' });
      return page.items.find((t) => t.id === checkout?.txId) ?? null;
    },
  });
  const settled = !!checkout && depositTx?.status === 'success';

  useEffect(() => { if (!settled) return; const t = setTimeout(() => close(), 2000); return () => clearTimeout(t); }, [settled, close]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!Number.isInteger(amountKesCents) || amountKesCents < minDepositCents) { setAmountError(`Enter at least ${both(minDepositCents)}.`); return; }
    if (maxDepositCents !== null && amountKesCents > maxDepositCents) { setAmountError(`Enter at most ${both(maxDepositCents)}.`); return; }
    setAmountError(null);
    if (!token) { deferToAuth(amountKesCents); openAuth('register'); return; }
    try {
      if (rail === 'payx') {
        // PayX settles whole units of the collection currency: round UP so the floor still holds.
        const res = await payx.mutateAsync({ amount: Math.ceil(amountKesCents / 100) * 100, ...(methodCode ? { method: methodCode } : {}) });
        if (!res.checkoutUrl) throw new Error('NO_CHECKOUT_URL');
        setCheckout({ url: res.checkoutUrl, txId: res.transactionId });
        return;
      }
      const res = await lipwa.mutateAsync({ amount: amountKesCents });
      setCheckout({ url: res.lipwaUrl, txId: res.transactionId });
    } catch (err) {
      setServerError(paymentErrorMessage(err));
    }
  }

  if (settled) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <SuccessTick />
        <h3 className="text-base font-semibold text-fg">Payment received</h3>
        <p className="text-sm text-muted">{fmt(amountKesCents)} has been added to your wallet.</p>
        <Button fullWidth onClick={close}>Done</Button>
      </div>
    );
  }

  if (checkout) {
    return <EmbeddedCheckout url={checkout.url} amountLabel={fmt(amountKesCents)} onBack={() => setCheckout(null)} onDone={close} pending={depositTx?.status !== 'failed'} failed={depositTx?.status === 'failed'} />;
  }

  return (
    <form className="mx-auto flex w-full max-w-sm flex-col gap-4 px-5 pb-6 pt-4" onSubmit={onSubmit} noValidate>
      <label className={['block cursor-text rounded-2xl border bg-surface-2 px-4 py-5 text-center transition', amountError ? 'border-down' : 'border-border focus-within:border-accent'].join(' ')}>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Amount</span>
        <div className="mt-2 flex items-baseline justify-center gap-1.5">
          <span className="text-2xl font-bold text-muted">{symbol}</span>
          <input
            name="amount" inputMode={isForeign ? 'decimal' : 'numeric'} autoComplete="off" autoFocus
            aria-label={`Amount to deposit in ${currency}`} placeholder="0"
            value={isForeign ? amount : grouped(amount)}
            onChange={(e) => { setTouched(true); setAmount(sanitizeAmount(e.target.value)); setAmountError(null); }}
            style={{ width: `${Math.max(1, ((isForeign ? amount : grouped(amount)) || '0').length)}ch` }}
            className="max-w-full bg-transparent text-4xl font-black tabular-nums text-fg outline-none placeholder:text-muted"
          />
        </div>
      </label>

      <div className="-mt-1 grid grid-cols-4 gap-2">
        {quick.map((q) => {
          const active = Number(amount) === q;
          return (
            <button key={q} type="button" onClick={() => { setTouched(true); setAmount(String(q)); setAmountError(null); }} aria-pressed={active}
              className={['rounded-lg border px-2 py-2 text-sm font-semibold tabular-nums transition', active ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface-2 text-fg hover:border-accent/60'].join(' ')}>
              {isForeign ? `${symbol}${q}` : grouped(String(q))}
            </button>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted">
        Min {both(minDepositCents)}{maxDepositCents !== null ? ` · Max ${both(maxDepositCents)}` : ''}{isForeign && amountKesCents > 0 ? ` · ≈ ${formatKes(amountKesCents)}` : ''}
      </p>
      {amountError ? <p className="text-center text-xs text-down">{amountError}</p> : null}

      <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
        <ShieldIcon />
        <p className="text-xs text-muted">Pay by <span className="font-medium text-fg">card, bank or mobile money</span>, securely, without leaving the app.</p>
      </div>

      {serverError ? <p className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm text-down" role="alert">{serverError}</p> : null}

      <Button type="submit" size="lg" fullWidth disabled={submitting}>
        {!token ? 'Sign up to deposit' : submitting ? 'Opening secure checkout…' : 'Continue to Pay'}
      </Button>
    </form>
  );
}

/**
 * The embedded PayHero checkout: an in-app modal holding PayHero's PCI-hosted payment page in an
 * iframe. Card details are entered inside PayHero's frame (never our app), so the player stays in the
 * app the whole time. A defensive "open securely" fallback covers the rare case the frame won't load.
 */
function EmbeddedCheckout({ url, amountLabel, onBack, onDone, pending, failed }: { url: string; amountLabel: string; onBack: () => void; onDone: () => void; pending: boolean; failed: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [stuck, setStuck] = useState(false);
  const ref = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => { const t = setTimeout(() => { if (!loaded) setStuck(true); }, 6000); return () => clearTimeout(t); }, [loaded]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <FailX />
        <h3 className="text-base font-semibold text-fg">Payment not completed</h3>
        <p className="text-sm text-muted">The payment was cancelled or didn’t go through. No money was deducted.</p>
        <Button fullWidth onClick={onBack}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="flex h-[70vh] max-h-[560px] flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} aria-label="Back" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">Complete your payment</div>
          <div className="text-xs text-muted">Paying {amountLabel} · secured by PayHero</div>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-up/15 px-2 py-1 text-[11px] font-semibold text-up"><ShieldIcon small /> Secure</span>
      </div>

      <div className="relative flex-1 overflow-hidden bg-surface-2">
        {!loaded ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-2">
            <Spinner />
            <p className="text-sm text-muted">Loading secure checkout…</p>
            {stuck ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-accent hover:underline">Taking too long? Open securely →</a> : null}
          </div>
        ) : null}
        <iframe
          ref={ref}
          src={url}
          title="PayHero secure checkout"
          onLoad={() => setLoaded(true)}
          allow="payment; clipboard-write"
          className="h-full w-full border-0"
        />
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <div className="flex-1 text-xs text-muted">
          {pending ? <span className="flex items-center gap-1.5"><PulseDot /> Waiting for your payment…</span> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onDone}>Close</Button>
      </div>
    </div>
  );
}

function ShieldIcon({ small }: { small?: boolean } = {}) {
  const c = small ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return <svg viewBox="0 0 24 24" className={`${c} shrink-0 text-up`} fill="none" aria-hidden><path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 22.3 5 18.4 5 14V6l7-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function PulseDot() { return <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-accent" /></span>; }
function Spinner() { return <svg className="h-9 w-9 animate-spin text-accent" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>; }
function SuccessTick() { return <svg className="h-10 w-10 text-accent" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.35" /><path d="M7 12.5l3.2 3.2L17 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function FailX() { return <svg className="h-10 w-10 text-danger" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.35" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>; }
