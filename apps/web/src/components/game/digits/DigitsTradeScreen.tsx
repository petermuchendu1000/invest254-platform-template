'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { DigitHeatmap } from '@/components/game/digits/DigitHeatmap';
import { DerivChart } from '@/components/game/digits/DerivChart';
import { VolatilitySelector } from '@/components/game/digits/VolatilitySelector';
import { EntryScanner, type ScanSuggestion } from '@/components/game/digits/EntryScanner';
import { DigitResultModal, type DigitResult } from '@/components/game/digits/DigitResultModal';
import { InsufficientBalanceModal, type InsufficientFundsInfo } from '@/components/game/digits/InsufficientBalanceModal';
import { DigitHistoryPanel } from '@/components/game/digits/DigitHistoryPanel';
import { useInvalidateDigitHistory } from '@/lib/game/useDigitHistory';
import { useGameSocket, type DigitSettledData } from '@/lib/game/GameSocketProvider';
import { instrumentById, DEFAULT_INSTRUMENT_ID, type Instrument } from '@/lib/game/instruments';
import { payoutForStake, stakeForPayout } from '@/lib/game/digitPayout';
import { useDisplayMoney, USD_LIMITS } from '@/lib/money';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useWallet } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useToast } from '@/lib/toast/ToastProvider';
import { useAuthUi } from '@/lib/auth/ui';

// ── Contract model ───────────────────────────────────────────────────────────────────────────────
const MARKETS = [
  { id: 'matchesdiffers', label: 'Matches/Differs' },
  { id: 'evenodd', label: 'Even/Odd' },
  { id: 'overunder', label: 'Over/Under' },
] as const;
type Market = (typeof MARKETS)[number]['id'];
type Outcome = 'even' | 'odd' | 'over' | 'under' | 'matches' | 'differs';

// Chart timeframe / zoom presets (1T = default). barSpacing = pixels per bar on the time scale.
const TIMEFRAMES = [
  { label: '1T', barSpacing: 7 },
  { label: '2T', barSpacing: 11 },
  { label: '5T', barSpacing: 16 },
  { label: '10T', barSpacing: 24 },
] as const;

// Display-only payout factor, mirroring the engine's DIGIT default (shared `digitPayoutFactor`,
// 0.95 ⇒ 5% edge). The ENGINE is authoritative for the actual payout; this only renders the CTA
// "return" and "% payout". Kept a local literal so the client bundle never pulls node:crypto via
// the shared barrel. return = stake × factor / winProb.
const PAYOUT_FACTOR = 0.95;
const WINDOW = 120; // ticks used for the digit-frequency heatmap

const lastDigitOf = (rate: number) => (((Math.round(rate * 100) % 10) + 10) % 10);

function winProbability(outcome: Outcome, barrier: number): number {
  switch (outcome) {
    case 'even':
    case 'odd':
      return 0.5;
    case 'over':
      return (9 - barrier) / 10;
    case 'under':
      return barrier / 10;
    case 'matches':
      return 0.1;
    case 'differs':
      return 0.9;
  }
  return 0;
}

const outcomesFor = (m: Market): [{ key: Outcome; label: string }, { key: Outcome; label: string }] =>
  m === 'evenodd'
    ? [{ key: 'even', label: 'Even' }, { key: 'odd', label: 'Odd' }]
    : m === 'overunder'
      ? [{ key: 'over', label: 'Over' }, { key: 'under', label: 'Under' }]
      : [{ key: 'matches', label: 'Matches' }, { key: 'differs', label: 'Differs' }];

/** Human, professional contract label for confirmations/receipts (e.g. "Over 5", "Matches 3"). */
function contractLabel(o: Outcome, barrier: number, pick: number): string {
  switch (o) {
    case 'even': return 'Even';
    case 'odd': return 'Odd';
    case 'over': return `Over ${barrier}`;
    case 'under': return `Under ${barrier}`;
    case 'matches': return `Matches ${pick}`;
    case 'differs': return `Differs ${pick}`;
  }
}

type Pending = { stakeCents: number; outcome: Outcome; manual: boolean; label: string };

/** Deriv-style binary/digits trade surface — trades REAL contracts against the authoritative engine. */
export function DigitsTradeScreen() {
  const [instId, setInstId] = useState<string>(DEFAULT_INSTRUMENT_ID);
  const instrument: Instrument = instrumentById(instId);
  const { getInstrumentTicks, getLastInstrumentTick, instrumentResetKey, subscribeInstrument, openDigit, onDigitSettled } = useGameSocket();
  const { fmt, both, symbol, isForeign, toKesCents, toDisplay, limit } = useDisplayMoney();
  const brand = useBrand();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openAuth = useAuthUi((s) => s.openAuth);
  const toast = useToast();
  const { data: wallet } = useWallet();
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  // Site stake limits. Money of record is KES cents; rendered in the brand's display currency.
  // Foreign brands floor at USD_LIMITS.minStake ($5) and never below the site's KES min (mirrors
  // BetPanel via `limit`). This is the SINGLE source of the min so the UI never shows raw cents.
  const { data: gameConfig } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });
  const minStakeCents = limit(USD_LIMITS.minStake, gameConfig?.minStakeCents ?? 25000);
  const maxStakeCents = gameConfig?.maxStakeCents;

  const [market, setMarket] = useState<Market>('evenodd');
  const [mode, setMode] = useState<'auto' | 'manual'>('manual');
  const [barrier, setBarrier] = useState(5); // Over/Under
  const [pick, setPick] = useState(0); // Matches/Differs

  // Chart toolbar UI state (presentational): timeframe/zoom + 1T menu.
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[0]);
  const [tfOpen, setTfOpen] = useState(false);
  const tfRef = useRef<HTMLDivElement | null>(null);

  const presets = useMemo(() => (isForeign ? [5, 10, 25, 50, 100, 250] : [50, 100, 200, 500, 1000, 5000]), [isForeign]);
  const step = isForeign ? 1 : 50;
  const [stake, setStake] = useState<string>(String(isForeign ? USD_LIMITS.minStake : 200));
  // Stake <-> Payout entry. In 'payout' mode the input is a TARGET gross payout and the stake is
  // derived from the PRIMARY outcome's odds (mirrors the reference, whose readout tracks the green
  // side). `stake`/`stakeCents` stay the single source of truth for place()/onCta/AUTO.
  const [amountMode, setAmountMode] = useState<'stake' | 'payout'>('stake');
  const [payoutInput, setPayoutInput] = useState<string>('');
  const primaryProb = winProbability(outcomesFor(market)[0].key, barrier);
  const stakeCents = useMemo(() => {
    if (amountMode === 'payout') {
      const p = Number.parseFloat(payoutInput);
      return Number.isFinite(p) && p > 0 ? stakeForPayout(toKesCents(p), primaryProb, PAYOUT_FACTOR) : 0;
    }
    const n = Number.parseFloat(stake);
    return Number.isFinite(n) && n > 0 ? toKesCents(n) : 0;
  }, [amountMode, stake, payoutInput, primaryProb, toKesCents]);

  // Client-side stake validity (money of record is KES cents). Blocks below-min / above-max BEFORE
  // hitting the engine, and drives a friendly currency-formatted hint (never raw cents).
  const stakeValid =
    Number.isFinite(stakeCents) && stakeCents >= minStakeCents && (maxStakeCents === undefined || stakeCents <= maxStakeCents);
  const stakeHint =
    stakeCents > 0 && stakeCents < minStakeCents
      ? `Minimum stake is ${both(minStakeCents)}`
      : maxStakeCents !== undefined && stakeCents > maxStakeCents
        ? `Maximum stake is ${both(maxStakeCents)}`
        : null;

  // Once site config loads, raise the stake to the minimum so the default is never below it.
  useEffect(() => {
    if (!gameConfig) return;
    const minU = isForeign ? Math.ceil(toDisplay(minStakeCents)) : Math.round(toDisplay(minStakeCents));
    const cur = Number.parseFloat(stake);
    if (!Number.isFinite(cur) || cur < minU) setStake(String(minU));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameConfig, minStakeCents, isForeign]);

  // AUTO-bot params (display-currency units for money, plain number for the multiplier).
  const [targetProfit, setTargetProfit] = useState(isForeign ? '20' : '2000');
  const [stopLoss, setStopLoss] = useState(isForeign ? '10' : '1000');
  const [multiplier, setMultiplier] = useState('2');

  // Session state (authoritative — driven by server digit_settled events).
  const [pnl, setPnl] = useState(0);
  const [flash, setFlash] = useState<{ won: boolean; delta: number } | null>(null);
  // Reactive mirror of the in-flight contract (pendingRef is a ref, so it can't drive render). Drives
  // the "trade in play" chip over the chart; set on place, cleared on settle.
  const [pendingView, setPendingView] = useState<{ label: string; stakeCents: number } | null>(null);
  const [running, setRunning] = useState(false);
  // Persisted trade-history feed invalidation + chart entry/settle markers for the current contract.
  const invalidateHistory = useInvalidateDigitHistory();
  const [entryMarker, setEntryMarker] = useState<{ tSec: number } | null>(null);
  const [settleMarker, setSettleMarker] = useState<{ digit: number; won: boolean; tSec: number } | null>(null);
  // Transiently highlights the CTA the Entry Scanner suggested after "Load Deep Scanner Bot".
  const [loadedOutcome, setLoadedOutcome] = useState<Outcome | null>(null);
  // Settled MANUAL trade shown as a focused result card (receipt). Null = no card open.
  const [result, setResult] = useState<DigitResult | null>(null);
  // A MANUAL trade blocked for lack of funds -> explicit top-up modal (current/required/shortfall).
  const [needFunds, setNeedFunds] = useState<InsufficientFundsInfo | null>(null);

  const [snap, setSnap] = useState<{ price: number; digit: number | null; changePct: number; freqs: number[] }>({
    price: 0,
    digit: null,
    changePct: 0,
    freqs: Array<number>(10).fill(0),
  });

  const pendingRef = useRef<Pending | null>(null);
  const runningRef = useRef(false);
  runningRef.current = running;
  const lossStreakRef = useRef(0);
  const autoOutcomeRef = useRef<Outcome>('even');
  const pnlRef = useRef(0);
  pnlRef.current = pnl;

  const totalReturnCents = useCallback(
    (cents: number, outcome: Outcome) => payoutForStake(cents, winProbability(outcome, barrier), PAYOUT_FACTOR),
    [barrier],
  );

  // Subscribe the socket to the selected instrument's authoritative feed (re-subscribes on change).
  useEffect(() => { subscribeInstrument(instId); }, [instId, subscribeInstrument]);

  // Close the timeframe menu on outside click.
  useEffect(() => {
    if (!tfOpen) return;
    const onDoc = (e: MouseEvent) => { if (tfRef.current && !tfRef.current.contains(e.target as Node)) setTfOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [tfOpen]);

  // Resolve settlements authoritatively from the engine (single in-flight contract at a time).
  useEffect(() => {
    const off = onDigitSettled((s: DigitSettledData) => {
      const settled = pendingRef.current; // capture BEFORE clearing (label + manual flag)
      pendingRef.current = null;
      setPendingView(null); // contract resolved -> drop the "in play" chip
      const won = s.won;
      const delta = s.pnlCents; // authoritative P/L in cents
      lossStreakRef.current = won ? 0 : lossStreakRef.current + 1;
      setPnl((x) => x + delta);
      setFlash({ won, delta });
      setSettleMarker({ digit: s.digit, won, tSec: Math.floor((getLastInstrumentTick()?.t ?? Date.now()) / 1000) });
      invalidateHistory(); // persist-backed receipt now exists → refresh the history panel
      // MANUAL trades open a focused result card (receipt); the AUTO bot reports P/L via its own HUD.
      if (settled?.manual) {
        setResult({
          won,
          label: settled.label,
          digit: s.digit,
          stakeCents: settled.stakeCents,
          payoutCents: s.payoutCents,
          pnlCents: delta,
        });
      }
      window.setTimeout(() => setFlash(null), 900);
    });
    return off;
  }, [onDigitSettled, invalidateHistory, getLastInstrumentTick]);

  const place = useCallback(
    (outcome: Outcome, cents: number, manual = false): boolean => {
      // Every rejection communicates WHY — but only for MANUAL trades; the AUTO bot fires every
      // ~250ms and must never spam toasts.
      if (!Number.isFinite(cents) || cents <= 0) {
        if (manual) toast.push({ tone: 'error', title: 'Enter a stake', description: 'Type a valid amount to trade.' });
        return false;
      }
      if (pendingRef.current) {
        if (manual) toast.push({ tone: 'info', title: 'Trade in progress', description: 'Wait for your current trade to settle.' });
        return false;
      }
      if (cents < minStakeCents) {
        if (manual) toast.push({ tone: 'error', title: 'Stake too low', description: `Minimum stake is ${both(minStakeCents)}.` });
        return false;
      }
      if (maxStakeCents !== undefined && cents > maxStakeCents) {
        if (manual) toast.push({ tone: 'error', title: 'Stake too high', description: `Maximum stake is ${both(maxStakeCents)}.` });
        return false;
      }
      if (!token) {
        if (manual) {
          toast.push({ tone: 'info', title: 'Sign in to trade', description: 'Log in or create an account to place a trade.' });
          openAuth('login');
        }
        return false;
      }
      if (cents > spendable) {
        if (manual) setNeedFunds({ requiredCents: cents, currentCents: spendable });
        return false;
      }
      if (winProbability(outcome, barrier) <= 0) {
        if (manual) toast.push({ tone: 'error', title: 'Not available', description: 'This pick has no valid payout — choose another barrier.' });
        return false;
      }
      const target = outcome === 'over' || outcome === 'under' ? barrier : outcome === 'matches' || outcome === 'differs' ? pick : 0;
      const label = contractLabel(outcome, barrier, pick);
      pendingRef.current = { stakeCents: cents, outcome, manual, label };
      setPendingView({ label, stakeCents: cents });
      setEntryMarker({ tSec: Math.floor((getLastInstrumentTick()?.t ?? Date.now()) / 1000) });
      setSettleMarker(null);
      openDigit({ instrumentId: instId, kind: outcome, target, stakeCents: cents });
      return true;
    },
    [token, spendable, openDeposit, openAuth, toast, barrier, pick, instId, instrument, openDigit, minStakeCents, maxStakeCents, getLastInstrumentTick, fmt, both, totalReturnCents],
  );

  // Entry (IN) + settle (result digit) markers for the CURRENT/last contract, drawn on the chart at
  // the exact ticks that opened and decided it. Kind is semantic; DerivChart maps it to brand colours.
  const chartMarkers = useMemo(() => {
    const m: Array<{ time: number; kind: 'entry' | 'win' | 'loss'; text?: string }> = [];
    if (entryMarker) m.push({ time: entryMarker.tSec, kind: 'entry', text: 'IN' });
    if (settleMarker) m.push({ time: settleMarker.tSec, kind: settleMarker.won ? 'win' : 'loss', text: String(settleMarker.digit) });
    return m;
  }, [entryMarker, settleMarker]);

  // Live snapshot (price / current digit / change% / heatmap) + AUTO-bot loop, off the tick stream.
  useEffect(() => {
    const id = window.setInterval(() => {
      const ticks = getInstrumentTicks();
      const n = ticks.length;
      if (n === 0) return;
      const last = ticks[n - 1]!;
      const digit = lastDigitOf(last.rate);
      const firstIdx = Math.max(0, n - 60);
      const first = ticks[firstIdx]!;
      const changePct = first.rate ? ((last.rate - first.rate) / first.rate) * 100 : 0;
      const win = Math.min(n, WINDOW);
      const counts = Array<number>(10).fill(0);
      for (let i = n - win; i < n; i++) { const dd = lastDigitOf(ticks[i]!.rate); counts[dd] = (counts[dd] ?? 0) + 1; }
      const freqs = counts.map((c) => (c / win) * 100);
      setSnap({ price: last.rate, digit, changePct, freqs });

      // AUTO bot: keep placing on the chosen outcome (martingale on loss) until target/stop.
      if (runningRef.current && !pendingRef.current) {
        const targetCents = toKesCents(Number.parseFloat(targetProfit) || 0);
        const stopCents = toKesCents(Number.parseFloat(stopLoss) || 0);
        if ((targetCents > 0 && pnlRef.current >= targetCents) || (stopCents > 0 && pnlRef.current <= -stopCents)) {
          setRunning(false);
          return;
        }
        const mult = Math.max(1, Number.parseFloat(multiplier) || 1);
        const base = stakeCents;
        const cap = Math.min(spendable || base, maxStakeCents ?? Number.POSITIVE_INFINITY);
        const next = Math.min(Math.round(base * Math.pow(mult, lossStreakRef.current)), cap);
        place(autoOutcomeRef.current, next, false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [getInstrumentTicks, place, stakeCents, spendable, multiplier, targetProfit, stopLoss, toKesCents]);

  const [primary, secondary] = outcomesFor(market);
  const needsDigit = market !== 'evenodd';
  const selectorValue = market === 'overunder' ? barrier : pick;
  const onSelectDigit = (d: number) => (market === 'overunder' ? setBarrier(d) : setPick(d));

  // Live "share" stat for the chart badge: the probability-weighted frequency of the selected side
  // across the recent tick window (even-share for Even/Odd, over-share for Over/Under, the picked
  // digit's frequency for Matches/Differs). Purely a live read of `snap.freqs`.
  const sharePct = useMemo(() => {
    const f = snap.freqs;
    if (market === 'evenodd') return f.reduce((a, v, i) => a + (i % 2 === 0 ? v : 0), 0);
    if (market === 'overunder') return f.reduce((a, v, i) => a + (i > barrier ? v : 0), 0);
    return f[pick] ?? 0;
  }, [snap.freqs, market, barrier, pick]);
  const shareLabel =
    market === 'evenodd' ? 'Even share' : market === 'overunder' ? `Over ${barrier} share` : `Digit ${pick} share`;

  // Round a cents figure into the input's display-currency string (whole units for KES brands).
  const toAmountStr = (cents: number) =>
    isForeign ? String(Math.round(toDisplay(cents) * 100) / 100) : String(Math.round(toDisplay(cents)));

  const stepStake = (dir: 1 | -1) => {
    const cur = amountMode === 'payout' ? payoutInput : stake;
    const setter = amountMode === 'payout' ? setPayoutInput : setStake;
    const n = Math.max(0, (Number.parseFloat(cur) || 0) + dir * step);
    setter(isForeign ? String(Math.round(n * 100) / 100) : String(Math.round(n)));
  };

  const onCta = (outcome: Outcome) => {
    if (mode === 'auto') {
      if (running) {
        setRunning(false);
        return;
      }
      autoOutcomeRef.current = outcome;
      lossStreakRef.current = 0;
      setRunning(true);
      return;
    }
    place(outcome, stakeCents, true);
  };

  const ctaMeta = (o: Outcome) => {
    const prob = winProbability(o, barrier);
    const disabled = prob <= 0;
    const profitPct = prob > 0 ? (PAYOUT_FACTOR / prob - 1) * 100 : 0;
    const ret = prob > 0 ? totalReturnCents(stakeCents, o) : 0;
    return { disabled, profitPct, ret };
  };

  // Apply an Entry Scanner suggestion: switch instrument + market (+ barrier/pick), arm AUTO mode,
  // and briefly highlight the suggested side so the user can start it with one tap.
  const applyScan = useCallback((s: ScanSuggestion) => {
    if (running) setRunning(false);
    setInstId(s.instrumentId);
    setMarket(s.market as Market);
    if (s.market === 'overunder' && s.digit != null) setBarrier(s.digit);
    if (s.market === 'matchesdiffers' && s.digit != null) setPick(s.digit);
    setMode('auto');
    setLoadedOutcome(s.side as Outcome);
    window.setTimeout(() => setLoadedOutcome(null), 5000);
  }, [running]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto overflow-x-hidden overscroll-contain p-0.5 pb-2 sm:gap-2 lg:flex-row lg:gap-3 lg:overflow-hidden lg:p-1">
      {/* Left rail (desktop only): persisted trade history. Mobile keeps history on its own page. */}
      <aside className="hidden lg:flex lg:w-[300px] lg:shrink-0 lg:min-h-0 lg:flex-col lg:overflow-y-auto">
        <DigitHistoryPanel />
      </aside>

      {/* Center pane: market tabs + chart + heatmap + digit selector (chart flex-fills on desktop) */}
      <div className="flex min-h-0 flex-col gap-1.5 sm:gap-2 lg:min-w-0 lg:flex-1 lg:overflow-hidden">
      {/* Market tabs — Matches/Differs · Even/Odd · Over/Under (active = outlined accent pill) */}
      <div className="flex items-center gap-1.5 xs:gap-2">
        {MARKETS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => { setMarket(m.id); if (running) setRunning(false); }}
            className={cn(
              'min-w-0 flex-1 truncate rounded-full border px-2 py-1.5 text-[clamp(11px,3.2vw,13px)] font-semibold transition',
              market === m.id
                ? 'border-accent bg-accent/10 text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Chart card — toolbar (1T · instrument · live share) + Deriv-style chart.
          STABLE HEIGHT (not flex-1): a fixed share of the viewport so toggling AUTO/MANUAL or
          returning from the AI scanner (which grows the console) can NEVER squeeze the chart — the
          root scrolls instead. Also must NOT clip (overflow-visible) so the toolbar dropdowns
          (timeframe / volatility) can extend beyond it; clipping is on the chart canvas only, below. */}
      <div className="relative flex h-[42vh] min-h-[220px] shrink-0 flex-col rounded-xl border border-border bg-surface lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
        <div className="flex items-center gap-1.5 p-2 pb-1">
          {/* 1T timeframe / zoom */}
          <div ref={tfRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setTfOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={tfOpen}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-[12px] font-bold text-accent transition hover:border-accent/60"
            >
              {tf.label}
            </button>
            {tfOpen ? (
              <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] z-30 w-28 rounded-lg border border-border bg-surface-2 p-1 shadow-2xl">
                {TIMEFRAMES.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="option"
                    aria-selected={o.label === tf.label}
                    onClick={() => { setTf(o); setTfOpen(false); }}
                    className={cn(
                      'block w-full rounded-md px-2 py-1.5 text-left text-xs font-semibold transition',
                      o.label === tf.label ? 'bg-accent/15 text-fg' : 'text-muted hover:text-fg',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Instrument dropdown (wide toolbar variant) — dynamic width, hugs content */}
          <div className="min-w-0">
            <VolatilitySelector
              wide
              instrument={instrument}
              price={snap.price || null}
              changePct={snap.changePct}
              onSelect={(i) => { setInstId(i.id); if (running) setRunning(false); }}
            />
          </div>

          {/* Live share badge (market-aware) — pinned right */}
          <span
            title={`${shareLabel} over last ${WINDOW} ticks`}
            className="ml-auto shrink-0 self-center rounded-lg border border-border bg-surface-2 px-2 py-1 text-[11px] font-bold tabular-nums text-fg"
          >
            {Math.round(sharePct)}%
          </span>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl">
          <DerivChart
            getTicks={getInstrumentTicks}
            getLastTick={getLastInstrumentTick}
            resetKey={instrumentResetKey}
            barSpacing={tf.barSpacing}
            markers={chartMarkers}
          />
          {pendingView ? (
            <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto flex w-fit items-center gap-2 rounded-full border border-accent/40 bg-surface-2/90 px-3 py-1 text-[12px] font-semibold text-fg shadow-lg backdrop-blur">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              {pendingView.label} · {fmt(pendingView.stakeCents)}
            </div>
          ) : null}
          {flash ? (
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full px-3.5 py-1 text-[13px] font-bold shadow-lg',
                flash.won ? 'bg-up text-white' : 'bg-down text-white',
              )}
            >
              {flash.won ? 'WON ' : 'LOST '}
              {flash.won ? '+' : ''}{fmt(flash.delta)}
            </div>
          ) : null}
        </div>
      </div>

      {/* Live digit-frequency stats (read-only): current digit ringed, hottest green, coldest red */}
      <DigitHeatmap
        freqs={snap.freqs}
        current={snap.digit}
        selected={null}
        selectable={false}
      />

      {/* DIGIT selector — barrier (Over/Under) or prediction (Match/Differ). Hidden for Even/Odd.
          "DIGIT" hugs the left; the numbers group to the right with a clear gap between them. */}
      {needsDigit ? (
        <div className="flex items-center gap-4 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.15em] text-muted">Digit</span>
          <div className="flex flex-1 items-center justify-between">
            {Array.from({ length: 10 }, (_, d) => (
              <button
                key={d}
                type="button"
                onClick={() => onSelectDigit(d)}
                aria-pressed={selectorValue === d}
                aria-label={`${market === 'overunder' ? 'Barrier' : 'Prediction'} digit ${d}`}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] font-bold tabular-nums transition',
                  selectorValue === d ? 'border border-accent text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      </div>

      {/* Right pane: the trade console + AI Entry Scanner (fixed-width rail on desktop) */}
      <div className="flex min-h-0 flex-col gap-1.5 sm:gap-2 lg:w-[380px] lg:shrink-0 lg:overflow-y-auto">
      {/* Console */}
      <div className="flex min-h-0 flex-col gap-1.5">
        {/* AUTO / MANUAL */}
        <div className="flex rounded-xl border border-border bg-surface p-1">
              {(['auto', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMode(m); if (running) setRunning(false); }}
                  className={cn(
                    'flex-1 rounded-lg py-2 text-[13px] font-extrabold uppercase tracking-wide transition',
                    mode === m ? 'bg-accent text-accent-fg shadow-[0_2px_16px_-4px_var(--pp-accent)]' : 'text-muted hover:text-fg',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Amount mode: enter a STAKE or a target PAYOUT (resolved against the primary side). */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Amount</span>
              <div className="flex rounded-lg border border-border bg-surface p-0.5 text-[11px] font-bold">
                {(['stake', 'payout'] as const).map((mm) => (
                  <button
                    key={mm}
                    type="button"
                    aria-pressed={amountMode === mm}
                    onClick={() => {
                      if (mm === amountMode) return;
                      if (mm === 'payout') setPayoutInput(toAmountStr(payoutForStake(stakeCents, primaryProb, PAYOUT_FACTOR)));
                      else setStake(toAmountStr(stakeCents));
                      setAmountMode(mm);
                    }}
                    className={cn('rounded-md px-2.5 py-1 capitalize transition', amountMode === mm ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
                  >
                    {mm}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount stepper — edits the active quantity (stake, or target payout in payout mode) */}
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => stepStake(-1)} aria-label="Decrease amount"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-xl font-light text-muted transition hover:border-accent/60 hover:text-fg">−</button>
              <div className="flex-1 text-center">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{amountMode === 'payout' ? 'Payout' : 'Stake'}</div>
                <div className="flex items-baseline justify-center gap-1.5">
                  <span className="text-base font-bold text-muted">{symbol}</span>
                  <input
                    inputMode="decimal"
                    value={amountMode === 'payout' ? payoutInput : stake}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
                      if (amountMode === 'payout') setPayoutInput(v); else setStake(v);
                    }}
                    aria-label={amountMode === 'payout' ? 'Target payout' : 'Stake amount'}
                    className="w-28 bg-transparent text-center text-[20px] font-extrabold tabular-nums text-fg outline-none"
                  />
                </div>
              </div>
              <button type="button" onClick={() => stepStake(1)} aria-label="Increase amount"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-xl font-light text-muted transition hover:border-accent/60 hover:text-fg">+</button>
            </div>

            {/* Presets */}
            <div className="grid grid-cols-6 gap-1.5 xs:gap-2">
              {presets.map((q) => {
                const active = Number(amountMode === 'payout' ? payoutInput : stake) === q;
                const belowMin = amountMode === 'stake' && toKesCents(q) < minStakeCents;
                return (
                  <button
                    key={q}
                    type="button"
                    disabled={belowMin}
                    onClick={() => (amountMode === 'payout' ? setPayoutInput(String(q)) : setStake(String(q)))}
                    className={cn(
                      'rounded-lg border py-1.5 text-[clamp(10.5px,2.8vw,12.5px)] font-semibold tabular-nums transition disabled:cursor-not-allowed disabled:opacity-30',
                      active ? 'border-accent/55 bg-accent/15 text-fg' : 'border-border bg-surface-2 text-muted hover:text-fg',
                    )}
                  >
                    {isForeign ? `${symbol}${q}` : q >= 1000 ? `${q / 1000}k` : q}
                  </button>
                );
              })}
            </div>

            {/* Resolved readout: the OTHER quantity — potential payout in Stake mode, required stake
                in Payout mode — computed against the primary side (Even/Over/Match), like the reference. */}
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{amountMode === 'payout' ? 'Stake' : 'Payout'}</span>
              <span className="text-sm font-bold tabular-nums text-fg">{fmt(amountMode === 'payout' ? stakeCents : payoutForStake(stakeCents, primaryProb, PAYOUT_FACTOR))}</span>
            </div>

            {/* Min/max hint — always shows the site minimum (currency-formatted, never raw cents);
                becomes a warning when the current stake is out of range. */}
            <p className={cn('text-center text-[11px]', stakeHint ? 'text-warn' : 'text-muted')}>
              {stakeHint ?? `Min ${both(minStakeCents)}${maxStakeCents !== undefined ? ` · Max ${both(maxStakeCents)}` : ''}`}
            </p>

            {/* AUTO-bot params (bot controls — only meaningful in AUTO mode) */}
            {mode === 'auto' ? (
              <div className="grid grid-cols-3 gap-2">
                <BotField icon="target" label="Target" prefix={symbol} value={targetProfit} onChange={setTargetProfit} tone="up" />
                <BotField icon="stop" label="Stop loss" prefix={symbol} value={stopLoss} onChange={setStopLoss} tone="down" />
                <BotField icon="mult" label="Mult" prefix="×" value={multiplier} onChange={setMultiplier} />
              </div>
            ) : null}

            {/* Dual payout CTAs */}
            <div className="grid grid-cols-2 gap-3">
              {[primary, secondary].map((o, i) => {
                const meta = ctaMeta(o.key);
                const isUp = i === 0;
                const active = running && autoOutcomeRef.current === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={meta.disabled || (!running && !stakeValid)}
                    onClick={() => onCta(o.key)}
                    className={cn(
                      'flex items-center justify-between rounded-xl border px-4 py-2.5 text-left transition disabled:opacity-40',
                      isUp ? 'border-up/40 bg-up/15 text-up hover:bg-up/25' : 'border-down/40 bg-down/15 text-down hover:bg-down/25',
                      active ? 'ring-2 ring-white/60' : loadedOutcome === o.key ? 'ring-2 ring-accent' : '',
                    )}
                  >
                    <div>
                      <div className="text-[17px] font-extrabold leading-tight">{mode === 'auto' && active ? 'Stop' : o.label}</div>
                      <div className="text-[11px] font-semibold tabular-nums opacity-90">{meta.profitPct.toFixed(2)}%</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[15px] font-extrabold tabular-nums">{fmt(meta.ret)}</div>
                      <div className="text-[11px] font-semibold opacity-75">Payout</div>
                    </div>
                  </button>
                );
              })}
            </div>
      </div>

      <EntryScanner currentInstrumentId={instId} busy={running} onApply={applyScan} />
      </div>

      <DigitResultModal result={result} onClose={() => setResult(null)} />

      <InsufficientBalanceModal
        info={needFunds}
        onClose={() => setNeedFunds(null)}
        onDeposit={(shortfallCents) => { setNeedFunds(null); openDeposit({ amountCents: shortfallCents }); }}
      />
    </div>
  );
}

function BotFieldIcon({ kind }: { kind: 'target' | 'stop' | 'mult' }) {
  const cls = cn('h-3 w-3', kind === 'target' ? 'text-up' : kind === 'stop' ? 'text-down' : 'text-muted');
  if (kind === 'target') {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" />
      </svg>
    );
  }
  if (kind === 'stop') {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="8" /><path d="M8 12h8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function BotField({
  label,
  prefix,
  value,
  onChange,
  tone,
  icon,
}: {
  label: string;
  prefix: string;
  value: string;
  onChange: (v: string) => void;
  tone?: 'up' | 'down';
  icon: 'target' | 'stop' | 'mult';
}) {
  return (
    <label className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2">
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">
        <BotFieldIcon kind={icon} />
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <span className="text-xs font-semibold text-muted">{prefix}</span>
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
          className={cn(
            'w-full bg-transparent text-base font-bold tabular-nums outline-none',
            tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg',
          )}
        />
      </div>
    </label>
  );
}
