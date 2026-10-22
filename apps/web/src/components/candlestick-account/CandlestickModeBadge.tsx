'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { useDisplayMoney } from '@/lib/money';
import { useWallet, useSetAccountMode, useTopupDemo } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useToast } from '@/lib/toast/ToastProvider';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { MK } from '@/lib/marketer/labels';
// The ONE Real/Demo panel the rest of the app already hangs off its balance trigger. The candlestick
// header gets the same card rather than a second one, so the three shells can never disagree about
// what switching accounts offers (top-up on demo, no Withdraw on demo — DEMO-3).
import { AccountMenu } from '@/components/wallet/AccountMenu';
import { useCandlestickUi } from '@/components/game/candlestick/ui';
import { useDemoTrade } from '@/lib/game/demoTrade';

/**
 * The candlestick header's ACCOUNT CHIP: which account is active, what is in it, and the switch.
 *
 * It was two things on the bar — a coloured "DEMO" pill, and a balance printed a few pixels away —
 * which asked the player to join two facts that are one fact. The mode is what the balance MEANS;
 * a figure with no account beside it is a number a player can act on while believing it is the
 * other account's money. One control now carries both, and tapping it opens the panel that changes
 * exactly that.
 *
 * WHAT STAYS LOUD. The demo state keeps the warn hue and always keeps its WORD, at every width,
 * because the one thing a trader must not be wrong about is which money a tap spends. Real is the
 * default and the safe state, so below `sm` it is carried by the dot and the label alone, which is
 * what buys the balance its room on a 320px bar. Colour is never the only carrier: the accessible
 * name spells the account out in both states.
 *
 * It used to be a static word, because this screen was built before anything here could reach the
 * demo wallet. The demo account is not new — `useSetAccountMode` (DEMO-1) and the shared
 * `AccountMenu` have carried it for the classic and digits shells all along — so this is a trigger
 * wired to that mechanism, not a new money path. Nothing about the switch is decided here: the
 * server moves the account and returns the new wallet, and every balance on the screen already
 * renders `wallet.real + wallet.bonus`, which IS the active account's spendable figure.
 *
 * Signed out there is nothing to switch between, so the badge stays the plain word it was.
 *
 * Note on the in-play guard: the digits pill refuses a switch while a contract is open by reading
 * `useGameSocket()`. This header is mounted OUTSIDE `GameSocketProvider` (AppShell), so it cannot
 * ask. The server refuses the switch itself in that case and `useSetAccountMode`'s fail toast says
 * so — the one outcome that must never pass silently.
 */
export function CandlestickAccountChip() {
  const token = useSession((s) => s.token);
  const { data: wallet } = useWallet();
  const { fmt } = useDisplayMoney();
  const setMode = useSetAccountMode();
  const tradeOpen = useCandlestickUi((st) => st.tradeOpen);
  const topup = useTopupDemo();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const toast = useToast();
  const { isMarketer: skin } = useMarketerSkin();
  const demoBalance = useDemoTrade((st) => st.balanceCents);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  // A MARKETER's active tab is their `marketerPractice` flag — account_mode stays 'demo' server-side
  // — so the badge must follow the PRESENTED tab, not `mode`, or it would read Demo on their real
  // (funny) money. Same derivation as the digits pill and the shared panel.
  const active: 'real' | 'demo' = wallet?.modeLocked
    ? (wallet.marketerPractice ? 'demo' : 'real')
    : (wallet?.mode === 'demo' ? 'demo' : 'real');
  const demo = active === 'demo';
  // MARKETER: game vocabulary (Coins/Practice), never real-money words.
  const label = demo ? (skin ? MK.practiceTab : 'Demo') : (skin ? MK.realTab : 'Real');

  /**
   * The chip. A quiet surface with a hairline, not a saturated pill: it sits next to the bar's one
   * filled button (Deposit) and a second strong colour beside it is what made the old bar noisy.
   * The STATE is carried by the dot and the label, and in demo by the warn-tinted border too.
   */
  const chip = cn(
    'flex h-10 shrink-0 items-center gap-1.5 rounded-lg border bg-surface-2 px-2 sm:gap-2 sm:px-2.5 md:h-9',
    demo ? 'border-warn/40' : 'border-border',
  );

  /**
   * SIGNED OUT is a DEMO account now, not an empty one.
   *
   * A guest can place a trade without registering, so this chip names the account that tap spends
   * and shows its balance — simulated, in this browser only (`lib/game/demoTrade`). The word DEMO
   * is always present here, at every width, for the same reason it is on the signed-in demo
   * account: the one thing a trader must not be wrong about is which money is at stake. There is
   * nothing to switch to, so it is a label rather than a button.
   */
  if (!token) {
    return (
      <span className={cn(chip, 'border-warn/40')} title={`Demo account, ${fmt(demoBalance)}`}>
        <ModeDot demo />
        <span className="flex min-w-0 flex-col items-start leading-none">
          <span className="text-[9px] font-bold uppercase leading-none tracking-widest text-warn">
            {skin ? MK.practiceTab : 'Demo'}
          </span>
          <span className="mt-0.5 max-w-[7.5rem] truncate text-xs font-bold tabular-nums text-fg sm:max-w-[10rem] sm:text-sm">
            {fmt(demoBalance)}
          </span>
        </span>
      </span>
    );
  }

  /* Signed in, wallet still loading: a neutral placeholder. It must NOT fall through to the guest
     branch above — showing a real trader their simulated demo balance, even for a moment, is the
     one confusion this chip exists to prevent. */
  if (!wallet) {
    return (
      <span className={cn(chip, 'text-[11px] font-bold uppercase tracking-wide text-muted')}>
        <ModeDot demo={demo} />
        {label}
      </span>
    );
  }

  const amount = fmt((wallet.real ?? 0) + (wallet.bonus ?? 0));

  const switchTo = (mode: 'real' | 'demo') => {
    if (mode === active || setMode.isPending) return;
    /**
     * Refuse while a contract is in flight, and SAY SO.
     *
     * The server refuses this too, so money was never at risk — but its refusal arrives as a
     * generic failure. The trade screen publishes `tradeOpen` precisely so the player is told the
     * actual reason. See the note in game/candlestick/ui.ts for why the header cannot read the
     * socket itself.
     */
    if (tradeOpen) {
      setOpen(false);
      toast.push({ tone: 'error', title: 'Trade open', description: 'Close your trade before switching account.' });
      return;
    }
    setMode.mutate(mode, {
      onSuccess: (r) => {
        setOpen(false);
        toast.push({ tone: 'success', title: r.mode === 'demo' ? 'Demo' : 'Real', description: fmt(r.wallet.real + r.wallet.bonus) });
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Could not switch', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} account, ${amount}. Switch account`}
        className={cn(
          chip,
          'transition hover:border-fg/30',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        )}
      >
        <ModeDot demo={demo} />

        <span className="flex min-w-0 flex-col items-start leading-none">
          {/*
            The account word. Always present for DEMO (the state that costs a player a real trade if
            they misread it) and from `sm` for Real, which is the default. `aria-hidden` because the
            button's accessible name already says the account in full, in both states.
          */}
          <span
            aria-hidden
            className={cn(
              'text-[9px] font-bold uppercase leading-none tracking-widest',
              demo ? 'text-warn' : 'hidden text-muted sm:block',
            )}
          >
            {label}
          </span>
          {/* The balance is the figure on this bar a player actually reads, so it is the strongest
              text in the chip. `tabular-nums` so it does not jitter as the money changes. */}
          <span className={cn('max-w-[7.5rem] truncate text-xs font-bold tabular-nums text-fg sm:max-w-[10rem] sm:text-sm', demo ? 'mt-0.5' : 'sm:mt-0.5')}>
            {amount}
          </span>
        </span>

        {/* Pure affordance, and the first thing to go when the row is tight: the chip is tappable
            with or without it, and at 320px those 20px belong to the brand mark. */}
        <svg viewBox="0 0 20 20" className="hidden h-3 w-3 shrink-0 text-muted sm:block" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5.5 8 4.5 4.5L14.5 8" />
        </svg>
      </button>
      {open ? (
        // The shared panel paints itself from the `--pp-*` tokens, and so does this header now — the
        // bar, the badge and the card all read the same brand theme, so the card can never wear a
        // different palette from the bar it hangs off. This wrapper used to re-point those
        // tokens at the mock's own hex palette, which was the one thing that made every brand's
        // account card look identical; it inherits them instead.
        <div className="contents">
          <AccountMenu
            wallet={wallet}
            fmt={fmt}
            // The badge sits at the LEFT edge of the header, so the 280px card opens rightwards or it
            // runs off a 320px screen.
            align="left"
            switching={setMode.isPending}
            toppingUp={topup.isPending}
            onSwitch={switchTo}
            onDeposit={() => { setOpen(false); openDeposit(); }}
            onWithdraw={() => { setOpen(false); openWithdraw(); }}
            onTopupDemo={() => topup.mutate(undefined, {
              onSuccess: (r) => toast.push({ tone: 'success', title: 'Demo balance topped up', description: fmt(r.demoBalance) }),
              onError: (e) => toast.push({ tone: 'error', title: 'Could not top up', description: e instanceof ApiError ? e.message : 'Try again.' }),
            })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The state dot.
 *
 * It is a redundant carrier, never the only one: the word is beside it in demo and the button's
 * accessible name spells the account out in both states, so a player who cannot tell warn from
 * accent loses nothing.
 */
function ModeDot({ demo }: { demo: boolean }) {
  return <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', demo ? 'bg-warn' : 'bg-accent')} />;
}

/**
 * Close the popover on an outside tap or Escape.
 *
 * `pointerdown`, not `mousedown`: on a touch screen the synthetic mouse event only arrives once the
 * tap completes, which makes the card feel slow to dismiss. Copied from the digits pill, where the
 * same hook is file-local rather than exported.
 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}
