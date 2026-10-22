'use client';

import { useState } from 'react';
import { useSession } from '@/lib/auth/session';
import { maskPhoneForDisplay } from '@invest254/shared/payments';
import { useWallet, useWalletFigures, useSetAccountMode, useTopupDemo } from '@/lib/wallet/hooks';
import { useBrand } from '@/lib/brand/BrandProvider';
import { mt5ServerName } from '@/lib/brand/mt5Server';
import { useDisplayMoney } from '@/lib/money';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's "Trading accounts" panel.
 *
 * Laid out against MetaTrader's own dialog: a blue title bar, label/value rows with blue-grey labels
 * and white values, a green primary action, and a footer strip with a copy affordance on the right.
 * Colours are the sampled MT5 dark theme (see lib/ui/mt5.ts).
 *
 * TWO THINGS FROM THE DIALOG ARE DELIBERATELY ABSENT.
 *
 * MetaTrader prints a PASSWORD and an INVESTOR password on this screen, because it has just
 * generated them for a demo account it created. Nothing here generates a credential, and rendering
 * a password field — real or placeholder — on an account page is a security anti-pattern: it puts a
 * secret on screen, into screenshots, and into anyone's shoulder view, for no purpose. With no
 * password shown, MetaTrader's "keep your passwords in a safe place" footer has nothing to warn
 * about either, so the strip carries the account identifier instead, which is what people actually
 * need to copy when they contact support.
 *
 * Every row is real: the name, the brand, the active account mode, the balance and the account id
 * all come from the session and the wallet.
 */
export function MT5AccountPanel({ embedded = false }: {
  /**
   * Opened from the account CARD on the phone Settings screen, which already names the account.
   *
   * MetaTrader's phone puts the account at the top of Settings as a card — *"Account card (top):
   * `John Smith` / `40739870 - MetaQuotes-Demo` / `Access Point EU 3` … and a chevron -> opens
   * saved-accounts management"* (docs/mt5/04-mobile-app.md section 7). This panel IS that
   * saved-accounts management, so when it opens underneath the card its own blue header would be a
   * second title for one thing, and a third blue band down a 360px screen.
   */
  embedded?: boolean | undefined;
} = {}) {
  const user = useSession((s) => s.user);
  const { data: wallet } = useWallet();
  const brand = useBrand();
  const money = useDisplayMoney();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const setMode = useSetAccountMode();
  const topup = useTopupDemo();
  /**
   * Which account is active, and what each one holds — from the ONE rule (wallet/figures).
   *
   * Never `wallet.mode`: a marketer's account_mode is permanently 'demo' (their stakes spend the demo
   * bucket, migration 0084) while the money they play and withdraw is presented as their REAL
   * account. Their Demo is the SEPARATE practice bucket (0176), and `marketerPractice` says which of
   * the two is live. Reading `mode` straight off the wallet put a marketer on "Demo account" the
   * moment they signed in, and then refused to let them leave it.
   */
  const figures = useWalletFigures();
  const [copied, setCopied] = useState(false);

  if (!user) return null;

  const demo = figures.demo;
  const currency = wallet?.currency || brand.currency || 'KES';
  // MetaTrader's own server naming ("<Broker>-Live07" / "<Broker>-Demo"), derived from the brand
  // in one place so every surface prints the same string.
  const server = mt5ServerName(brand, demo ? 'demo' : 'real');
  const balanceCents = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user.userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked (insecure context, denied permission) — the id is on screen to read */
    }
  };

  /**
    * BOTH account types switch. `modeLocked` is not "cannot switch" — it is the money layer's
    * marketer predicate (fn_is_marketer_account), and a marketer switching to Demo moves to their
    * practice bucket exactly as a player switching to Demo moves to theirs. The waves switcher has
    * always allowed it; this panel was alone in disabling the rows and printing "Switching is
    * disabled on this account", which left a marketer with no demo at all.
    */
  const realCents = figures.realCash;
  const demoCents = figures.demoBalance;

  return (
    <section className="overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)]">
      {embedded ? null : (
        <header className="bg-[var(--mt5-blue)] px-3 py-2 text-[13px] font-semibold text-white">
          Trading account: {brand.name || brand.slug || 'invest254'}
        </header>
      )}

      {/* MetaTrader's left column is an account SWITCHER, and there is a real one here: the Real and
          Demo accounts the wallet already carries. Listing them is the mock's structure driving a
          feature that exists, rather than chrome for its own sake. Stacks above the detail on a
          phone, sits beside it from `sm`, as the dialog does. */}
      <div className="flex flex-col sm:flex-row">
        <nav className="shrink-0 border-b border-[var(--mt5-border)] sm:w-56 sm:border-b-0 sm:border-r">
          {([['real', 'Real account', realCents], ['demo', 'Demo account', demoCents]] as const).map(([mode, label, cents]) => {
            const active = demo ? mode === 'demo' : mode === 'real';
            return (
              <button
                key={mode}
                type="button"
                disabled={setMode.isPending || active}
                onClick={() => setMode.mutate(mode)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2.5 text-left transition',
                  active ? 'bg-[var(--mt5-raised)]' : 'hover:bg-[var(--mt5-raised)]/60',
                )}
              >
                <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-sm', active ? 'bg-[var(--mt5-blue)]' : 'bg-[var(--mt5-border)]')}>
                  <svg viewBox="0 0 24 24" className={cn('h-3.5 w-3.5', active ? 'text-white' : 'text-[var(--mt5-text)]')} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <circle cx="12" cy="8" r="3.2" />
                    <path d="M5 20a7 7 0 0114 0" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className={cn('block truncate text-[13px]', active ? 'text-[var(--mt5-blue-link)]' : 'text-[var(--mt5-text)]')}>{label}</span>
                  <span className={cn('block truncate font-mono text-[11px]', active ? 'text-[var(--mt5-blue-link)]' : 'text-[var(--mt5-muted)]')}>
                    {money.fmt(cents)}
                  </span>
                </span>
              </button>
            );
          })}

        </nav>

        <div className="min-w-0 flex-1 px-4 py-4">
        <h2 className="mb-3 text-[14px] font-semibold text-[var(--mt5-text)]">
          {demo ? 'Demo account' : 'Live account'}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          <Row label="Name" value={user.username} />
          <Row label="Server" value={server} />
          <Row label="Account type" value={`${demo ? 'Demo' : 'Real'} ${currency}`} />
          <Row label="Balance" value={money.fmt(balanceCents)} strong />
          {/* MetaTrader's Login. Ours is the account identifier support asks for. */}
          <Row label="Account ID" value={user.userId} strong mono />
          {/* Masked: this panel is the screen players screenshot for support, and the number is the
              login identity and the payout destination — it must not travel in a screenshot. */}
          {user.phone ? <Row label="Phone" value={maskPhoneForDisplay(user.phone)} /> : null}
        </dl>

        {/* A demo account nobody can refill is a demo account that works once. MetaTrader's own demo
            is reopened at its starting balance, and this is that: available on the demo account to
            whoever is on it — player or marketer, whose demo is their practice bucket. It moves no
            real money, so it sits beside the live switch rather than competing with it. */}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {demo ? (
            <button
              type="button"
              onClick={() => topup.mutate()}
              disabled={topup.isPending}
              className="rounded border border-[var(--mt5-border)] px-4 py-2 text-[13px] font-semibold text-[var(--mt5-text)] transition hover:bg-[var(--mt5-raised)] disabled:opacity-60"
            >
              {topup.isPending ? 'Topping up…' : 'Top up demo balance'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => (demo ? setMode.mutate('real') : openDeposit({}))}
            disabled={setMode.isPending}
            // MetaTrader's primary action is BLUE. This was the app's own accent green, which is
            // the one colour that still said "casino" on an otherwise MetaTrader screen. The deposit
            // and withdraw sheets this opens are already blue, through MT5_TOKENS.
            className="rounded bg-[var(--mt5-blue)] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#2567cc] disabled:opacity-60"
          >
            {demo ? 'Switch to your live account' : 'Fund your account'}
          </button>
        </div>
        </div>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-3 py-2">
        <span className="text-[12px] text-[var(--mt5-muted)]">Quote this ID when you contact support</span>
        <button
          type="button"
          onClick={copyId}
          className={cn('flex items-center gap-1.5 text-[12px] font-medium transition', copied ? 'text-[var(--mt5-green)]' : 'text-[var(--mt5-blue-link)] hover:text-[var(--mt5-blue)]')}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 012-2h10" strokeLinecap="round" />
          </svg>
          {copied ? 'Copied' : 'Copy to clipboard'}
        </button>
      </footer>
    </section>
  );
}

function Row({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <>
      <dt className="text-[var(--mt5-muted)]">{label}</dt>
      <dd className={cn('break-all text-[var(--mt5-text)]', strong && 'font-semibold', mono && 'font-mono text-[12px]')}>{value}</dd>
    </>
  );
}
