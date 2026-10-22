'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, kesToCents } from '@invest254/shared/money';
import type { Direction } from '@invest254/shared';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useHydrated } from '@/lib/useHydrated';
import { useDisplayMoney } from '@/lib/money';
import { useStakeLimits } from '@/lib/game/useStakeLimits';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { isContinuousBrand } from '@/lib/game/levelWatch';
import { useLivePrice } from '@/components/game/candlestick/useLivePrice';
import { useCandlestickUi } from '@/components/game/candlestick/ui';
import { dataPhaseOf, tradeDisabledReason } from '@/lib/ui/dataPhase';
import { CurrentTradePanel } from '@/components/game/candlestick/CurrentTradePanel';
import { useDemoTrade, demoLive, DEMO_FALLBACK_MULTIPLIER } from '@/lib/game/demoTrade';

/**
 * The candlestick screen's order entry, laid out exactly as the mock lays it out: the two sides,
 * an amount and a stop beside each other, the brand's range under them, four quick stakes, a
 * summary block, and the refusal line.
 *
 * It is NOT a restyled `BetPanel` and not MetaTrader's ticket. The three are different arrangements
 * of the same trade, and the rules that decide what a tap DOES are the ones `BetPanel` carries,
 * copied here deliberately rather than shared through a hook: a logged-out tap is buying intent and
 * opens the deposit sheet seeded with the stake; a short balance does the same; one tap is one
 * trade. Those three rules are the money path, so they are written where they can be read.
 *
 * The contract is the brand's own: stake, direction and the brand's default duration. The mock has
 * no expiry control and neither does this, which is why the duration is read from `/game/config`
 * rather than offered — a screen that silently changed the contract would not be a UI change.
 */
export function TradingPanel({ className }: { className?: string }) {
  const hydrated = useHydrated();
  const brand = useBrand();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const { data: wallet } = useWallet();
  const { both, symbol, isForeign, toKesCents, toDisplay } = useDisplayMoney();
  const limits = useStakeLimits();
  const { status, activePosition, openPosition, sell, earlyCloseEnabled } = useGameSocket();
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });

  /**
   * Tell the header whether a contract is in flight, so its Real/Demo switch can refuse mid-trade
   * with a reason rather than letting the player try and get a generic failure. The header sits
   * outside GameSocketProvider and cannot see this itself — see the note in ui.ts.
   */
  const setTradeOpen = useCandlestickUi((s) => s.setTradeOpen);
  useEffect(() => {
    setTradeOpen(!!activePosition);
    return () => setTradeOpen(false);
  }, [activePosition, setTradeOpen]);

  const [stake, setStake] = useState('');
  const [stopLoss, setStopLoss] = useState('');

  /**
   * Seed the amount with the brand's minimum ONCE, when the limits land.
   *
   * Re-seeding whenever the field is empty turns "select all, type 200" into "50200" — the field is
   * briefly empty mid-edit. `BetPanel` carries the same guard for the same reported bug.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !limits.ready) return;
    seeded.current = true;
    setStake((s) => (s === '' ? String(limits.min) : s));
  }, [limits.ready, limits.min]);

  const stakeCents = useMemo(() => {
    const n = Number.parseFloat(stake);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return isForeign ? toKesCents(n) : kesToCents(n);
  }, [stake, isForeign, toKesCents]);

  const minCents = limits.minCents;
  const maxCents = limits.maxCents;
  // Bonus funds are stakeable (bonus-first, migration 0094), so affordability counts real + bonus.
  const demoBalance = useDemoTrade((st) => st.balanceCents);
  /**
   * What this tap can actually spend. A guest spends the simulated demo balance, a signed-in trader
   * spends their wallet — the two are never added together and never substituted for each other.
   */
  const spendable = token ? (wallet?.real ?? 0) + (wallet?.bonus ?? 0) : demoBalance;
  const validStake = Number.isInteger(stakeCents) && stakeCents >= minCents;
  const overMax = maxCents !== undefined && Number.isFinite(stakeCents) && stakeCents > maxCents;
  const overBalance = Number.isFinite(stakeCents) && stakeCents > spendable;
  const connecting = status !== 'open';

  /**
   * Can a stop actually be honoured on this brand?
   *
   * The engine holds protective levels as PRICES and fires them on its own tick. It has no money
   * stop, and deriving a price from a shilling figure would be new game math, which this change is
   * not. So the field is drawn exactly as the mock draws it and is disabled where it would do
   * nothing, with the reason on it, rather than accepting a figure nothing would ever act on.
   */
  const stopSupported = isContinuousBrand({ chartStyle: brand.chartStyle, earlyCloseEnabled });

  const chips = limits.ladder.slice(0, 4);
  const durationS = config?.defaultDurationS ?? 10;

  const refusal = (() => {
    if (!Number.isFinite(stakeCents)) return null;
    if (!validStake) return `Minimum stake is ${both(minCents)}`;
    if (overMax && maxCents !== undefined) return `Maximum stake is ${both(maxCents)}`;
    // A guest over their simulated balance would otherwise tap and have nothing happen at all:
    // `demoOpen` refuses silently, as it should, so the reason has to be said here.
    if (!token && overBalance) return 'Not enough demo balance for that stake.';
    return null;
  })();

  /**
   * THE GUEST DEMO. Simulated, in this browser only, and never mixed with a real contract: a
   * signed-in trader's panel never looks at `demoPos`, and a guest has no real position to look at.
   */
  const demoPos = useDemoTrade((st) => st.position);
  const demoOpen = useDemoTrade((st) => st.open);
  const demoSettle = useDemoTrade((st) => st.settle);
  /**
   * Deliberately NOT `config.maxMultiplier`.
   *
   * That field is the CEILING the engine will ever pay (5x on this brand), not what a winning
   * contract typically returns. Paying it on every simulated win would have the demo advertise a
   * return the live market does not give, which is the one thing a demo must not do — so this is a
   * conservative, representative figure instead.
   */
  const demoMultiplier = DEMO_FALLBACK_MULTIPLIER;
  const { tick, priceOfRate, digits } = useLivePrice();
  const livePrice = priceOfRate(tick?.rate);

  /** Ticks the simulated figures. 100ms, as `LivePnl` does, so the countdown reads smoothly. */
  const [demoNow, setDemoNow] = useState(() => Date.now());
  useEffect(() => {
    if (!demoPos) return;
    const id = setInterval(() => setDemoNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [demoPos]);

  const demo = demoPos ? demoLive(demoPos, demoNow) : null;

  /** Settle once the contract has run its course. The store ignores a second call for the same id. */
  useEffect(() => {
    if (!demoPos || !demo?.expired) return;
    demoSettle(demoPos.id);
  }, [demoPos, demo?.expired, demoSettle]);

  /** One contract at a time, whichever kind it is. */
  const inFlight = !!activePosition || !!demoPos;

  function place(direction: Direction) {
    if (!validStake || overMax || connecting || inFlight) return;
    /**
     * A LOGGED-OUT TAP OPENS A DEMO TRADE, not the deposit sheet.
     *
     * It used to open deposit seeded with the stake, on the argument that a logged-out tap is
     * buying intent and funding should lead. The product decision is now the one the mock makes:
     * let anybody trade the demo first and ask for the account afterwards. Nothing about this
     * touches money — the balance is this browser's localStorage and the outcome is simulated; see
     * the module note on `demoTrade`, which is explicit about the win rate being a configured one.
     */
    if (!token) {
      if (livePrice === null) return;
      demoOpen({ direction, stakeCents, entryPrice: livePrice, durationS, multiplier: demoMultiplier });
      return;
    }
    // A signed-in trader who cannot cover the stake still gets the deposit sheet, seeded and
    // resumable — that path is about REAL money and is unchanged.
    if (overBalance) {
      openDeposit({ amountCents: stakeCents, pending: { direction, stakeCents } });
      return;
    }
    // One tap = one trade. The stake is explicit on screen and the position is closeable, so a
    // confirmation step would only add measurable drop-off.
    openPosition({ stakeCents, direction, durationS });
  }

  const money = (cents: number) => (isForeign ? `${symbol} ${toDisplay(cents).toFixed(2)}` : `KSh ${centsToKes(cents).toFixed(2)}`);

  /** The instrument, named the way the quote band names it. */
  const market = `GLOBAL/${(brand.currency ?? 'KES').toUpperCase()}`;

  /**
   * WHILE A CONTRACT IS IN FLIGHT the panel IS the contract.
   *
   * The order form is replaced rather than left disabled underneath: there is nothing a trader can
   * do with it until this settles, and on a phone it was pushing the one figure they are watching
   * below the fold. Both kinds of contract render the same panel — the engine's numbers for a real
   * one, the simulation's for a guest's demo.
   */
  if (activePosition) {
    const totalMs = activePosition.durationS * 1000;
    const remainingMs = activePosition.expiresAtMs ? Math.max(0, activePosition.expiresAtMs - demoNow) : totalMs;
    return (
      <div className={cn('flex h-full w-full min-w-0 flex-col bg-surface p-3 sm:p-4', className)}>
        <CurrentTradePanel
          direction={activePosition.direction}
          market={market}
          entryPrice={activePosition.entryRate === null ? null : priceOfRate(activePosition.entryRate)}
          priceDigits={digits}
          stakeCents={activePosition.stakeCents}
          secondsLeft={Math.ceil(remainingMs / 1000)}
          progress={totalMs > 0 ? 1 - remainingMs / totalMs : 0}
          livePnlCents={activePosition.livePnlCents}
          estReturnCents={activePosition.stakeCents + activePosition.livePnlCents}
          livePrice={livePrice}
          phase={activePosition.phase}
          {...(earlyCloseEnabled
            ? { onClose: () => sell(), closeDisabled: !(activePosition.phase === 'open' && activePosition.sellable && activePosition.positionId) }
            : {})}
        />
      </div>
    );
  }

  if (demoPos && demo) {
    return (
      <div className={cn('flex h-full w-full min-w-0 flex-col bg-surface p-3 sm:p-4', className)}>
        <CurrentTradePanel
          direction={demoPos.direction}
          market={market}
          entryPrice={demoPos.entryPrice}
          priceDigits={digits}
          stakeCents={demoPos.stakeCents}
          secondsLeft={demo.secondsLeft}
          progress={demo.progress}
          livePnlCents={demo.livePnlCents}
          estReturnCents={demo.estReturnCents}
          livePrice={livePrice}
          phase="open"
        />
      </div>
    );
  }

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col bg-surface p-3 sm:p-4', className)}>
      <div className="mb-4 hidden min-w-0 items-center justify-start text-sm font-bold text-fg sm:flex">
        Trading Panel
        <span className="mx-1 truncate text-xs font-normal text-muted">({(brand.currency ?? 'KES').toUpperCase()})</span>
      </div>

      {/* The two sides. Disabled while a contract is in flight: this brand opens one at a time. */}
      <div className="mb-5 flex gap-2">
        <button
          type="button"
          disabled={connecting || inFlight}
          onClick={() => place('buy')}
          className="h-11 min-w-0 flex-1 rounded-lg bg-up text-sm font-bold tracking-wide text-accent-fg transition-colors hover:bg-up/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          BUY
        </button>
        <button
          type="button"
          disabled={connecting || inFlight}
          onClick={() => place('sell')}
          className="h-11 min-w-0 flex-1 rounded-lg bg-down text-sm font-bold tracking-wide text-accent-fg transition-colors hover:bg-down/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          SELL
        </button>
      </div>

      {/* Two dead buttons with no explanation is the same dead state as a blank chart, in a control.
          Both reasons they can be dead are named — the feed, and a contract already in flight. The
          second is not self-evident: its live P&L panel is far below the stake fields and is off the
          fold on a phone. Nothing renders once the panel works, so the mock's spacing is kept. */}
      {connecting || inFlight ? (
        <p className="-mt-4 mb-4 text-center text-[11px] text-muted" role="status" aria-live="polite">
          {connecting
            ? tradeDisabledReason(dataPhaseOf(status, false))
            : 'Trade in progress — one at a time on this market.'}
        </p>
      ) : null}

      {/*
        Two fields across, as the mock has them. The panel is only ~288px wide at 320px and 320px
        wide in the desktop rail, so each field gets ~140px: the prefix is sized to the tightest of
        those and the input's left padding clears it by a few pixels, where `pl-12` against a 16px
        prefix left almost nothing for a six-digit stake. `min-w-0` on the cells because a grid
        item's `auto` minimum would otherwise let a long value push the column past the rail.
      */}
      <div className="mb-1 grid grid-cols-2 gap-2 sm:gap-3">
        <div className="min-w-0">
          <span className="mb-2 block truncate text-xs uppercase tracking-wider text-muted">Trade Amount</span>
          <div className="relative">
            <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted">{isForeign ? symbol : 'KSh'}</div>
            <input
              inputMode="decimal"
              value={stake}
              onChange={(e) => setStake(e.target.value.replace(/[^\d.]/g, ''))}
              className={cn(
                'h-11 w-full min-w-0 rounded-lg border bg-bg pl-10 pr-2.5 text-base font-bold tabular-nums text-fg outline-none sm:text-sm',
                refusal ? 'border-down' : 'border-border focus:border-accent',
              )}
            />
          </div>
        </div>
        <div className="min-w-0">
          <span className="mb-2 block truncate text-xs uppercase tracking-wider text-muted">Stop Loss</span>
          <div className="relative">
            <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted">{isForeign ? symbol : 'KSh'}</div>
            <input
              inputMode="decimal"
              value={stopLoss}
              disabled={!stopSupported}
              title={stopSupported ? undefined : 'This contract settles at expiry, so a stop has nothing to close early.'}
              onChange={(e) => setStopLoss(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="Optional"
              className="h-11 w-full min-w-0 rounded-lg border border-border bg-bg pl-10 pr-2.5 text-base font-bold tabular-nums text-fg outline-none placeholder:font-normal placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
            />
          </div>
        </div>
      </div>

      {/*
        The brand's own range, under the fields, exactly where the mock puts it. A brand whose
        ceiling runs to seven digits makes this string longer than the 288px panel, so it is allowed
        to wrap BETWEEN the two figures and never inside one, and it reserves its line height so the
        ladder below it does not jump when the limits land.
      */}
      <div className="mb-4 flex min-h-4 flex-wrap items-center gap-x-1.5 text-xs text-muted">
        {limits.ready ? (
          <>
            <span className="whitespace-nowrap tabular-nums">{money(minCents)}</span>
            <span aria-hidden="true">–</span>
            <span className="whitespace-nowrap tabular-nums">{maxCents !== undefined ? money(maxCents) : '∞'}</span>
          </>
        ) : null}
      </div>

      {/*
        Four quick stakes off the brand's ladder — the mock's four columns.
        The figures are the brand's own and run to five or six digits, which does not fit four
        across a 288–320px panel WITH a currency prefix on each. So the narrowest phones get a 2x2
        grid that keeps the prefix, and from 360px up it is the mock's four columns carrying the bare
        figure — the currency is named by the panel heading, which appears at those same widths.
      */}
      <div className="mb-5 grid grid-cols-2 gap-1 xs:grid-cols-4">
        {chips.map((v) => {
          const active = Number.parseFloat(stake) === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setStake(String(v))}
              className={cn(
                'flex h-10 min-w-0 items-center justify-center gap-1 rounded-lg border px-0.5 text-sm font-medium tracking-tight transition-colors xs:text-xs',
                active
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-border bg-surface-2 text-fg hover:border-muted/40',
              )}
            >
              <span className="xs:hidden">{isForeign ? symbol : 'KSh'}</span>
              <span className="truncate tabular-nums">{v.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      {/*
        The summary block, pinned to the bottom of the panel (`mt-auto`) as the mock pins it.

        It no longer carries the in-flight contract: that now REPLACES the whole panel (see the
        early returns above), which is what the mock does and what keeps the live P&L on screen
        instead of below the fold on a phone.
      */}
      {/*
        DROPPED ON A VERY SHORT PHONE (under 600px tall), where the whole tab has to fit one screen
        and this block is the only thing on it that says nothing new: the live price is already in
        the quote band two inches above, and the stake is in its own input right there. Clipping the
        stake fields or the BUY/SELL pair to keep a duplicate readout would be the wrong trade.
      */}
      <div className="mt-auto hidden min-w-0 space-y-2 rounded-lg bg-surface-2 p-3 [@media(min-height:600px)]:block sm:p-4">
        {/* Label fixed, figure allowed to shrink: a six-figure stake is the long half of the row,
            and without `min-w-0` + `truncate` it widened the whole panel instead. */}
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="shrink-0 text-muted">Live Price</span>
          <LivePriceReadout />
        </div>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="shrink-0 text-muted">Stake</span>
          <span className="min-w-0 truncate font-bold tabular-nums text-fg">{Number.isFinite(stakeCents) ? money(stakeCents) : '—'}</span>
        </div>
      </div>

      {/* The mock's refusal line. Present only when there is something to refuse. */}
      {hydrated && refusal ? (
        <div className="mt-3 rounded border border-down/50 bg-down/10 p-2.5 text-center text-xs text-down">
          {refusal}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The live price, in its own component so a price moving several times a second re-renders one
 * `<span>` rather than the whole panel — the amount field a trader is mid-way through typing into
 * is in this tree.
 */
function LivePriceReadout() {
  const { tick, priceOfRate, digits } = useLivePrice();
  const price = priceOfRate(tick?.rate);
  return <span className="min-w-0 truncate font-mono text-up">{price === null ? '—' : price.toFixed(digits)}</span>;
}
