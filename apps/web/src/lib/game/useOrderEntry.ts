'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Direction } from '@invest254/shared';
import { valueOfRate } from '@invest254/shared/candles';
import { LOT_STAKE_CENTS } from '@invest254/shared/account';
import { effectiveVolume, volumeSpecOf, volumeDigitsOf } from '@invest254/shared/symbols';
import { useGameSocket, useGameSocketApi } from '@/lib/game/GameSocketProvider';
import { useChartSymbolStore, chartOverride } from '@/lib/game/chartSymbol';
import { useStakeLimits } from '@/lib/game/useStakeLimits';
import { useSession } from '@/lib/auth/session';
import { useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useHydrated } from '@/lib/useHydrated';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useVolumeStore, useRestoreVolume } from '@/lib/game/volume';
import { useDurationStore, useRestoreDuration, effectiveDuration } from '@/lib/game/duration';
import { api } from '@/lib/api/endpoints';
import type { ActivePosition } from '@/lib/game/betting';
import type { Tick } from '@/lib/game/types';
import type { LocalRefusal } from '@/lib/game/orderResult';
import { useLevelsStore } from '@/lib/game/levelsStore';
import { levelPrice, isContinuousBrand } from '@/lib/game/levelWatch';

/**
 * Everything an order-entry surface needs, in one place.
 *
 * MetaTrader has two of them, and so does this terminal: the full order ticket (desktop, and the
 * phone's own New Order screen) and the chart's one-click panel. They are the same order — the same
 * volume, the same limits, the same deposit routing, the same `openPosition` call — wearing
 * different controls, so the logic is here rather than written twice.
 *
 * It was written twice for about an hour, which is how this hook came to exist: `place()` carries
 * the rule that a tap by a logged-out or short-funded player is buying intent and must open the
 * deposit sheet seeded with the stake rather than fail, and two copies of that rule would drift.
 */
export interface OrderEntry {
  /** False until the client has mounted; a surface renders a skeleton rather than a wrong stake. */
  ready: boolean;

  /** The symbol the CHART is on, which is the one the surface names. */
  symbol: string;
  /** The symbol this brand settles, which is the only one an order can be placed on. */
  settledSymbol: string;
  digits: number;
  /** The live price of `symbol`, or null before the first quote. */
  price: number | null;
  /**
   * MetaTrader's two sides, around `price`, by the spread the engine charges.
   *
   * Null where the brand quotes one price. A ticket that has this shows Bid and Ask the way
   * MetaTrader's does; one that does not shows the single number it always did.
   */
  bidAsk: { bid: number; ask: number } | null;
  /** True when the chart is on a symbol this brand will not accept an order on. */
  tradeDisabled: boolean;
  connecting: boolean;

  lots: number;
  minLots: number;
  maxLots: number;
  /** Decimals the volume prints to: one more than the step's where the brand's minimum is off-grid. */
  volDigits: number;
  /** This symbol's own volume step, which the stepper and the slider move by. */
  volStep: number;
  /**
   * Set the volume, snapped to the symbol's grid and clamped to the range, and RETURN what was
   * applied. The return is what lets a typed figure be reported: MetaTrader's Volume field takes
   * any keystrokes and validates on commit, so a surface has to be able to say that 12 was read
   * and 0.5 was used rather than appear to ignore the typing.
   */
  setLots: (lots: number) => number;
  /** Add to the volume and clamp it to the brand's limits. */
  bump: (delta: number) => void;
  /**
   * Why the volume cannot move, in the trader's words, or null while the range is open.
   *
   * MetaTrader states a symbol's volume limits (its contract specification carries min, max and
   * step) and its dialogs explain a bound rather than just greying a control out. A ticket whose
   * steppers are both disabled and says nothing is the reported bug.
   */
  volNote: string | null;
  stakeCents: number;
  /** Signed in, and the stake is more than the wallet holds. */
  overBalance: boolean;
  /** Whether there is a session at all, which decides whether `overBalance` is worth reporting. */
  signedIn: boolean;

  durationS: number;
  setDurationS: (s: number) => void;
  durations: readonly number[];

  /** Place the order, or route to the deposit sheet. A no-op where trade is disabled. */
  /**
   * Send the order, and say what happened to it.
   *
   * `'sent'` means a frame went to the engine and the window should wait for the result;
   * `'deposit'` means the tap was routed to the deposit sheet, which is its own surface and needs
   * no rejection in the window; anything else is a refusal with its reason.
   */
  place: (dir: Direction) => 'sent' | 'deposit' | LocalRefusal;

  activePosition: ActivePosition | null;
  earlyCloseEnabled: boolean;
  /**
   * Whether this brand's engine prices a position CONTINUOUSLY, so a Stop Loss and a Take Profit
   * really close one at their price. See `isContinuousBrand` in lib/game/levelWatch.ts.
   */
  continuous: boolean;
  tick: Tick | null;
  /** The display price of a raw engine rate, on the CURRENT day's anchor. */
  priceOfRate: (rate: number | null | undefined) => number | null;
  market: ReturnType<ReturnType<typeof useGameSocketApi>['getMarket']>;
  /** Back to the brand's own symbol, which is how a surface offers the way out of Disabled. */
  chartSettled: () => void;
}

/** The contract terms a ticket offers, in seconds. The Specification states them as Expiration. */
export const DURATION_OPTIONS = [10, 30, 60, 120];

/** "10s", "1m", "2m" — the labels the Expiry row prints. */
export const durationLabel = (s: number): string => (s < 60 ? `${s}s` : `${s / 60}m`);

export function useOrderEntry(): OrderEntry {
  const hydrated = useHydrated();
  const brand = useBrand();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const limits = useStakeLimits();
  const { data: wallet } = useWallet();
  const { status, activePosition, openPosition, earlyCloseEnabled, spread } = useGameSocket();
  const { getLastTick, getMarket, getSymbolQuote, getSettledSymbol } = useGameSocketApi();
  const charted = useChartSymbolStore((st) => st.symbol);
  const setCharted = useChartSymbolStore((st) => st.set);
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });

  /**
   * The contract term, from the store beside the volume's rather than a `useState`.
   *
   * See lib/game/duration for why: every order-entry surface, and the chart menu's pending-order
   * row, has to be on the term the trader actually set. A stored term the brand no longer offers
   * falls back to its default, which is what `effectiveDuration` is for.
   */
  const defaultDurationS = config?.defaultDurationS ?? 10;
  const durations = useMemo(
    () => Array.from(new Set([...DURATION_OPTIONS, defaultDurationS])).sort((a, b) => a - b),
    [defaultDurationS],
  );
  useRestoreDuration();
  const storedDuration = useDurationStore((s) => s.durationS);
  const setDurationS = useDurationStore((s) => s.set);
  const durationS = effectiveDuration(storedDuration, durations, defaultDurationS);

  // Quote updates ride the tick stream, which does not re-render React on its own.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);

  const market = getMarket();
  /**
   * The surface follows the CHART, as MetaTrader's order dialog does: it belongs to the symbol you
   * opened it on. This brand settles one of them, so every other symbol is quoted and charted with
   * MetaTrader's own `Disabled` trade mode, and the surface says so rather than offering a button
   * that would open a position on a different instrument from the one on screen.
   */
  /**
   * `charted` is what was STORED; `override` is whether the chart is genuinely on another
   * instrument. They are not the same question, and conflating them is what printed
   * `Trade disabled for XAUUSD` on a chart drawing XAUUSD. See `chartOverride` in lib/game/chartSymbol.
   */
  const settled = getSettledSymbol() ?? market?.instrument.symbol ?? null;
  const settledSymbol = settled ?? 'XAUUSD';
  const override = chartOverride(charted, settled);
  const quote = override === null ? null : getSymbolQuote(override);
  const tradeDisabled = override !== null;
  const symbol = override ?? settledSymbol;
  const digits = quote?.instrument.digits ?? market?.instrument.digits ?? 2;
  /**
   * The live quote, which must be one the ENGINE sent.
   *
   * The tick buffer can hold invented ticks on a classic brand (see `Tick.synthetic`); pricing one
   * would put a number on the ticket that no server ever quoted, directly above the Buy and Sell
   * buttons. No quote at all is the honest state, and every field below already renders it.
   */
  const lastTick = getLastTick();
  const tick = lastTick && lastTick.synthetic !== true ? lastTick : null;
  const priceOfRate = (rate: number | null | undefined): number | null =>
    market && rate !== null && rate !== undefined
      ? market.anchor.base + market.instrument.scale * (valueOfRate(rate) - market.anchor.openValue)
      : null;
  const price = override === null ? (tick ? priceOfRate(tick.rate) : null) : quote?.price ?? null;

  /**
   * MetaTrader's BID and ASK, which this brand has always had and never showed.
   *
   * `price` above is the brand's quoted number, the one the chart draws and a position's entry is
   * stamped at: MetaTrader calls a chart drawn on it `Last` mode, and its Specification dialog
   * carries exactly that setting (`Chart mode`: `Last` or `Bid`). The two sides sit either side of
   * it by the spread the engine already charges.
   *
   * The arithmetic is the engine's own, not a presentation choice. A continuous position is worth
   * `clamp(1 + gain * (move - cost), 0, max)`, so a BUY breaks even once the price has risen by
   * `cost` and a SELL once it has fallen by `cost` — which is what paying the ask and being filled
   * at the bid means. `cost` is in curve-value units and a price is `base + scale * value`, so the
   * offset in price terms is `cost * scale`, the same conversion `priceOfRate` makes one line up.
   *
   * Null when the brand publishes no spread: a line brand settles a committed contract where
   * nothing is priced continuously, and an engine older than the field says nothing. Both mean one
   * price, which is what this ticket showed before and still shows.
   */
  const scale = market?.instrument.scale ?? null;
  const bidAsk = price !== null && spread !== null && scale !== null
    ? { bid: price - spread.sell * scale, ask: price + spread.buy * scale }
    : null;

  // ── Volume ─────────────────────────────────────────────────────────────────────────────────────
  /**
   * The symbol's OWN volume spec, intersected with the brand's money limits.
   *
   * MetaTrader carries min, max and step on every symbol and the ticket obeys that symbol's three
   * numbers: a book is not one setting. The brand's limits still win where they are tighter,
   * because they are what the engine enforces, and the step is always the symbol's, because
   * granularity is not a limit. See `conventionalVolume` in the shared package.
   *
   * It follows the symbol the SURFACE is on, which is the charted one, exactly as the digits and
   * the price above do: a ticket opened on an index has to offer an index's volumes.
   */
  const brandMinLots = limits.minCents / LOT_STAKE_CENTS;
  // A brand may set no ceiling; the symbol's own then stands.
  const brandMaxLots = limits.maxCents === undefined ? null : limits.maxCents / LOT_STAKE_CENTS;
  const spec = volumeSpecOf(symbol);
  const vol = effectiveVolume(spec, brandMinLots, brandMaxLots);
  const minLots = vol.min;
  const maxLots = vol.max;
  const volStep = vol.step;
  /**
   * Decimals the volume prints to, from the shared rule rather than from a copy of it here.
   *
   * The off-grid-minimum case (0.025 lots on a hundredth step) used to be worked out in this hook
   * alone, so the ticket printed three places and every grid printed two for the same position. It
   * now lives in `volumeDigitsOf`, which the grids read through `useVolumeDigits`.
   */
  const volDigits = volumeDigitsOf(vol);
  /**
   * The volume lives in a shared store, not in this hook's own state.
   *
   * Two surfaces can place an order — the chart's one-click panel and the order ticket — and
   * MetaTrader treats them as one order: step the panel to 0.10, tap BUY, and the dialog opens on
   * 0.10. With a `useState` per hook instance it opened on the brand's minimum and the volume the
   * trader had chosen was dropped. See lib/game/volume.
   */
  const stored = useVolumeStore((st) => st.lots);
  const setStored = useVolumeStore((st) => st.set);
  useRestoreVolume();

  const clampLots = (v: number): number => {
    const snapped = Number(v.toFixed(volDigits));
    return Math.min(maxLots, Math.max(minLots, snapped));
  };
  /**
   * Snapped to the SYMBOL's step, measured from its minimum.
   *
   * An index steps in tenths, so 0.15 is not a volume on one; and a brand minimum of 0.025 puts
   * the whole grid on 0.025, 0.035, 0.045 rather than on round hundredths. Stepping without this
   * let a stepper walk off the grid and stay off it.
   */
  const snapToStep = (v: number): number => {
    const steps = Math.round((v - minLots) / volStep);
    return clampLots(Number((minLots + steps * volStep).toFixed(volDigits + 2)));
  };
  /**
   * Clamped on READ as well as on write, so a volume remembered from a session when the brand
   * allowed more cannot survive the brand lowering its ceiling, and a stake below a raised minimum
   * cannot be sent.
   */
  const lots = stored === null ? minLots : clampLots(stored);
  // The first surface to learn the brand's limits seeds the store with the minimum, which is what
  // MetaTrader opens a fresh ticket on.
  useEffect(() => {
    if (!limits.ready || useVolumeStore.getState().lots !== null) return;
    useVolumeStore.setState({ lots: minLots });
  }, [limits.ready, minLots]);

  // Stepped ON the symbol's grid: a +0.01 on an index that steps in tenths is not a step at all,
  // and MetaTrader's own stepper moves by the symbol's step.
  const bump = (delta: number) => setStored(snapToStep(lots + delta));
  const setLots = (v: number): number => {
    const applied = snapToStep(v);
    setStored(applied);
    return applied;
  };

  /**
   * The reason a bound is a bound, which MetaTrader always has: volume limits come from the
   * symbol's contract specification and the brand's own stake range, and both are knowable
   * numbers. Null while there is room to move, so a surface prints nothing in the normal case.
   */
  const volNote = !limits.ready
    ? null
    : limits.inverted
      ? `This brand's maximum stake is below its minimum, so ${symbol}'s own ceiling of ${spec.max} lots applies.`
      : maxLots - minLots < volStep / 2
        ? `This brand's minimum and maximum stake are the same, so ${minLots.toFixed(volDigits)} lots is the only volume it accepts.`
        : null;

  const stakeCents = Math.round(lots * LOT_STAKE_CENTS);
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
  const overBalance = !!token && stakeCents > spendable;
  const connecting = status !== 'open';

  // The ticket's working copy of the levels, which `place` hands to the engine as absolute prices.
  const levels = useLevelsStore((s) => s.levels);
  const levelRef = useLevelsStore((s) => s.ref);

  function place(dir: Direction): 'sent' | 'deposit' | LocalRefusal {
    if (connecting) return 'OFFLINE';
    // Defence in depth behind the disabled buttons: this brand settles one symbol, and an order
    // raised while the chart is on another would open a position on an instrument the trader is
    // not looking at.
    if (tradeDisabled) return 'WRONG_SYMBOL';
    // A logged-out or short-funded tap is real buying intent: route it to the deposit sheet seeded
    // with this stake, which then resumes the trade. Same behaviour as the classic panel.
    if (!token || overBalance) {
      openDeposit({ amountCents: stakeCents, pending: { direction: dir, stakeCents } });
      return 'deposit';
    }
    // Null means it went. Anything else is the engine's rule, refused here, and the order window
    // says so: this used to be a silent return and a tap that did nothing.
    /**
     * MetaTrader arms the protective levels WITH the order, so they go in the same message.
     *
     * Sent as absolute chart prices and resolved here, where the ticket's reference price is known.
     * The engine holds them from this moment on: this is the hand-off that turns a level the tab was
     * drawing into a stop that fires whether or not the tab is open.
     */
    const ref = levelRef ?? price;
    return openPosition({
      stakeCents, direction: dir, durationS,
      slPrice: levelPrice(levels, ref, 'sl', digits),
      tpPrice: levelPrice(levels, ref, 'tp', digits),
    }) ?? 'sent';
  }

  return {
    ready: hydrated,
    symbol, settledSymbol, digits, price, bidAsk, tradeDisabled, connecting,
    lots, minLots, maxLots, volDigits, volStep, setLots, bump, volNote, stakeCents, overBalance, signedIn: !!token,
    durationS, setDurationS, durations,
    place,
    activePosition, earlyCloseEnabled,
    continuous: isContinuousBrand({ chartStyle: brand.chartStyle, earlyCloseEnabled }),
    tick, priceOfRate, market,
    chartSettled: () => setCharted(null),
  };
}
