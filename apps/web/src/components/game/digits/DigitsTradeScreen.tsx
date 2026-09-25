'use client';

import { FitText } from '@/components/ui/FitText';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { DigitHeatmap } from '@/components/game/digits/DigitHeatmap';
import { DerivChart } from '@/components/game/digits/DerivChart';
import { VolatilitySelector } from '@/components/game/digits/VolatilitySelector';
import { MultipliersPanel } from '@/components/game/digits/MultipliersPanel';
import { TradeTypesSheet, type TradeTypeId } from '@/components/game/digits/TradeTypes';
import { EntryScanner, type ScanSuggestion } from '@/components/game/digits/EntryScanner';
import { DigitResultModal, type DigitResult } from '@/components/game/digits/DigitResultModal';
import { InsufficientBalanceModal, type InsufficientFundsInfo } from '@/components/game/digits/InsufficientBalanceModal';
import { PositionsPanel } from '@/components/game/digits/PositionsPanel';
import { DIcon } from '@/components/game/digits/icons';
import type { DerivChartHandle } from '@/components/game/digits/DerivChart';
import { useDigitSession } from '@/lib/game/digitSession';
import { useAmountText } from '@/lib/game/useAmountText';
import { play } from '@/lib/sound/sound';
import { useInvalidateDigitHistory } from '@/lib/game/useDigitHistory';
import { useGameSocket, type DigitSettledData } from '@/lib/game/GameSocketProvider';
import { instrumentById, DEFAULT_INSTRUMENT_ID, type Instrument } from '@/lib/game/instruments';
import { payoutForStake, stakeForPayout } from '@/lib/game/digitPayout';
import { useDisplayMoney, USD_LIMITS } from '@/lib/money';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useWallet, useTopupDemo } from '@/lib/wallet/hooks';
import { afterSettle, nextAuto, runPnl, startRun, type AutoRun, type AutoStop } from '@/lib/game/autoBot';
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

type Pending = { stakeCents: number; outcome: Outcome; manual: boolean; label: string; openedAtMs: number; demo: boolean };

/** Deriv-style binary/digits trade surface — trades REAL contracts against the authoritative engine. */
export function DigitsTradeScreen() {
  const [instId, setInstId] = useState<string>(DEFAULT_INSTRUMENT_ID);
  const instrument: Instrument = instrumentById(instId);
  const { getInstrumentTicks, getLastInstrumentTick, instrumentResetKey, subscribeInstrument, openDigit, onDigitSettled, onDigitRejected } = useGameSocket();
  const { fmt, both, symbol, isForeign, toKesCents, toDisplay, limit } = useDisplayMoney();
  const brand = useBrand();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openAuth = useAuthUi((s) => s.openAuth);
  const toast = useToast();
  const { data: wallet } = useWallet();
  const topupDemo = useTopupDemo();
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
  const amt = useAmountText();
  // DIGITS-UI: publish the live session to the shell (positions rail/sheet, auto pill, history).
  const publishOpen = useDigitSession((s) => s.setOpenContract);
  const publishClosed = useDigitSession((s) => s.addClosed);
  const publishAuto = useDigitSession((s) => s.setAuto);
  // Chart tools (DIGITS-UI): line/area, draw a horizontal line, export, zoom/follow.
  const chartRef = useRef<DerivChartHandle | null>(null);
  const [chartVariant, setChartVariant] = useState<'line' | 'area'>('line');
  const [drawMode, setDrawMode] = useState(false);
  const [railOpen, setRailOpen] = useState(true);

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
  // DERIV-UI: Multipliers sits beside the digits contracts (Demo account only — see TradeTypes.tsx).
  const [multi, setMulti] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
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
  // Stake for a side. In payout mode each side needs its own stake to return the typed payout
  // (BUGLOG #86: the secondary side used the primary side's stake and paid a different amount).
  const stakeFor = useCallback((o: Outcome): number => {
    if (amountMode === 'payout') {
      const p = Number.parseFloat(payoutInput);
      return Number.isFinite(p) && p > 0 ? stakeForPayout(toKesCents(p), winProbability(o, barrier), PAYOUT_FACTOR) : 0;
    }
    const n = Number.parseFloat(stake);
    return Number.isFinite(n) && n > 0 ? toKesCents(n) : 0;
  }, [amountMode, stake, payoutInput, barrier, toKesCents]);
  const stakeCents = stakeFor(outcomesFor(market)[0].key);

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
  const pendingTimerRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  runningRef.current = running;
  // The current AUTO run: its own P&L baseline, trade count and loss streak (autoBot.ts).
  const runRef = useRef<AutoRun | null>(null);
  const autoOutcomeRef = useRef<Outcome>('even');
  const pnlRef = useRef(0);
  pnlRef.current = pnl;

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    if (pendingTimerRef.current) { window.clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    setPendingView(null);
    publishOpen(null);
  }, [publishOpen]);

  const totalReturnCents = useCallback(
    (cents: number, outcome: Outcome) => payoutForStake(cents, winProbability(outcome, barrier), PAYOUT_FACTOR),
    [barrier],
  );

  // Subscribe the socket to the selected instrument's authoritative feed (re-subscribes on change).
  useEffect(() => { subscribeInstrument(instId); }, [instId, subscribeInstrument]);
  const isDemo = wallet?.mode === 'demo';
  useEffect(() => { if (!isDemo && multi) setMulti(false); }, [isDemo, multi]);

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
      clearPending(); // contract resolved -> drop the "in play" chip
      const won = s.won;
      const delta = s.pnlCents; // authoritative P/L in cents
      if (runRef.current && settled && !settled.manual) runRef.current = afterSettle(runRef.current, won);
      pnlRef.current += delta; // the loop may decide before React re-renders
      setPnl((x) => x + delta);
      setFlash({ won, delta });
      play(won ? 'win' : 'loss');
      const nowMs = Date.now();
      if (settled) {
        publishClosed({
          id: s.positionId ?? `${nowMs}`, label: settled.label, stakeCents: settled.stakeCents, payoutCents: s.payoutCents,
          pnlCents: delta, won, digit: s.digit, openedAtMs: settled.openedAtMs, settledAtMs: nowMs, demo: settled.demo,
        });
      }
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
          durationMs: nowMs - settled.openedAtMs,
        });
      }
      window.setTimeout(() => setFlash(null), 900);
    });
    return off;
  }, [onDigitSettled, invalidateHistory, getLastInstrumentTick, publishClosed, clearPending]);

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
        if (manual) {
          // Demo: refill in place (no menu hunt). Real: the top-up sheet with the shortfall.
          if (wallet?.mode === 'demo') topupDemo.mutate(undefined, { onSuccess: (r) => toast.push({ tone: 'success', title: 'Demo refilled', description: amt.text(r.demoBalance) }) });
          else setNeedFunds({ requiredCents: cents, currentCents: spendable });
        }
        return false;
      }
      if (winProbability(outcome, barrier) <= 0) {
        if (manual) toast.push({ tone: 'error', title: 'Not available', description: 'This pick has no valid payout — choose another barrier.' });
        return false;
      }
      const target = outcome === 'over' || outcome === 'under' ? barrier : outcome === 'matches' || outcome === 'differs' ? pick : 0;
      const label = contractLabel(outcome, barrier, pick);
      const openedAtMs = Date.now();
      if (!openDigit({ instrumentId: instId, kind: outcome, target, stakeCents: cents })) return false; // offline: nothing in play
      pendingRef.current = { stakeCents: cents, outcome, manual, label, openedAtMs, demo: wallet?.mode === 'demo' };
      setPendingView({ label, stakeCents: cents });
      publishOpen({ label, stakeCents: cents, openedAtMs });
      if (manual) play('place');
      setEntryMarker({ tSec: Math.floor((getLastInstrumentTick()?.t ?? Date.now()) / 1000) });
      setSettleMarker(null);
      // Backstop (BUGLOG #85): a contract settles within seconds; if no answer ever comes (dropped
      // socket, lost frame) the screen must not stay "in play" forever. History/wallet re-sync.
      if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = window.setTimeout(() => {
        if (pendingRef.current?.openedAtMs !== openedAtMs) return;
        clearPending();
        invalidateHistory();
      }, 20_000);
      return true;
    },
    [token, spendable, openAuth, toast, barrier, pick, instId, openDigit, minStakeCents, maxStakeCents, getLastInstrumentTick, both, publishOpen, wallet?.mode, topupDemo, amt, clearPending, invalidateHistory],
  );

  // BUGLOG #85: the engine refused the open (funds, limits, one-at-a-time): nothing is in play. The
  // provider already told the player why; AUTO stops rather than retrying the same refusal.
  const stopAutoRef = useRef<(reason: AutoStop | 'user' | 'rejected') => void>(() => {});
  useEffect(() => onDigitRejected(() => {
    if (!pendingRef.current) return;
    clearPending();
    if (runningRef.current) stopAutoRef.current('rejected');
  }), [onDigitRejected, clearPending]);

  // Entry (IN) + settle (result digit) markers for the CURRENT/last contract, drawn on the chart at
  // the exact ticks that opened and decided it. Kind is semantic; DerivChart maps it to brand colours.
  const chartMarkers = useMemo(() => {
    const m: Array<{ time: number; kind: 'entry' | 'win' | 'loss'; text?: string }> = [];
    if (entryMarker) m.push({ time: entryMarker.tSec, kind: 'entry', text: 'IN' });
    if (settleMarker) m.push({ time: settleMarker.tSec, kind: settleMarker.won ? 'win' : 'loss', text: String(settleMarker.digit) });
    return m;
  }, [entryMarker, settleMarker]);

  // Everything the loop reads, refreshed every render, so ONE interval runs for the screen's lifetime
  // (it used to be torn down and rebuilt on every balance/stake change).
  const loop = useRef({ place, stakeFor, spendable, multiplier, targetProfit, stopLoss, toKesCents, minStakeCents, maxStakeCents });
  loop.current = { place, stakeFor, spendable, multiplier, targetProfit, stopLoss, toKesCents, minStakeCents, maxStakeCents };

  // Live snapshot (price / current digit / change% / heatmap) + AUTO-bot loop, off the tick stream.
  useEffect(() => {
    let lastT = -1; let lastN = -1;
    const id = window.setInterval(() => {
      const ticks = getInstrumentTicks();
      const n = ticks.length;
      if (n === 0) return;
      const last = ticks[n - 1]!;
      // Re-render only when a new tick arrived (was 4 renders a second of the whole screen).
      if (last.t !== lastT || n !== lastN) {
        lastT = last.t; lastN = n;
        const digit = lastDigitOf(last.rate);
        const first = ticks[Math.max(0, n - 60)]!;
        const changePct = first.rate ? ((last.rate - first.rate) / first.rate) * 100 : 0;
        const win = Math.min(n, WINDOW);
        const counts = Array<number>(10).fill(0);
        for (let i = n - win; i < n; i++) { const dd = lastDigitOf(ticks[i]!.rate); counts[dd] = (counts[dd] ?? 0) + 1; }
        setSnap({ price: last.rate, digit, changePct, freqs: counts.map((c) => (c / win) * 100) });
      }

      // AUTO: one decision whenever nothing is in play (autoBot.ts).
      const run = runRef.current;
      if (runningRef.current && run && !pendingRef.current) {
        const L = loop.current;
        const d = nextAuto(run, pnlRef.current, {
          baseCents: L.stakeFor(autoOutcomeRef.current),
          multiplier: Number.parseFloat(L.multiplier) || 1,
          targetCents: L.toKesCents(Number.parseFloat(L.targetProfit) || 0),
          stopLossCents: L.toKesCents(Number.parseFloat(L.stopLoss) || 0),
          minCents: L.minStakeCents, maxCents: L.maxStakeCents, balanceCents: L.spendable,
        });
        if (d.kind === 'stop') stopAutoRef.current(d.reason);
        else if (!L.place(autoOutcomeRef.current, d.stakeCents, false)) stopAutoRef.current('rejected');
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [getInstrumentTicks]);

  // Start / stop AUTO. A run keeps its own P&L, so the button always works again (BUGLOG #84).
  const startAuto = useCallback((o: Outcome) => {
    autoOutcomeRef.current = o;
    runRef.current = startRun(pnlRef.current);
    setRunning(true);
  }, []);
  const stopAuto = useCallback((reason: AutoStop | 'user' | 'rejected') => {
    const run = runRef.current;
    runRef.current = null;
    setRunning(false);
    if (!run || reason === 'rejected') return;       // the refusal was already shown
    const p = runPnl(run, pnlRef.current);
    const title = reason === 'target' ? 'Target hit' : reason === 'stoploss' ? 'Stop loss hit' : reason === 'funds' ? 'Balance too low' : reason === 'stake' ? 'Stake below minimum' : 'Auto stopped';
    toast.push({ tone: reason === 'target' ? 'success' : reason === 'user' ? 'info' : 'error', title, description: `${amt.signed(p)} · ${run.trades}` });
  }, [toast, amt]);
  stopAutoRef.current = stopAuto;
  const halt = () => { if (runningRef.current) stopAuto('user'); };

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
      if (running) { stopAuto('user'); return; }
      if (!token) { openAuth('login'); return; }
      startAuto(outcome);
      return;
    }
    place(outcome, stakeFor(outcome), true);
  };

  const ctaMeta = (o: Outcome) => {
    const prob = winProbability(o, barrier);
    const disabled = prob <= 0;
    const profitPct = prob > 0 ? (PAYOUT_FACTOR / prob - 1) * 100 : 0;
    const ret = prob > 0 ? totalReturnCents(stakeFor(o), o) : 0;
    return { disabled, profitPct, ret };
  };

  // Entry Scanner: load the best entry (instrument, market, side, digit) and RUN it on AUTO with the
  // current stake, target, stop loss and multiplier (BUGLOG #84: it used to only arm the screen).
  const applyScan = useCallback((s: ScanSuggestion) => {
    if (runningRef.current) stopAuto('user');
    setInstId(s.instrumentId);
    setMulti(false);
    setMarket(s.market as Market);
    if (s.market === 'overunder' && s.digit != null) setBarrier(s.digit);
    if (s.market === 'matchesdiffers' && s.digit != null) setPick(s.digit);
    setMode('auto');
    setLoadedOutcome(s.side as Outcome);
    window.setTimeout(() => setLoadedOutcome(null), 3000);
    if (!token) { openAuth('login'); return; }
    startAuto(s.side as Outcome);
  }, [startAuto, stopAuto, token, openAuth]);

  // DIGITS-UI: the shell's "Auto · <side>" pill follows the running bot.
  useEffect(() => {
    publishAuto(running ? { side: outcomesFor(market).find((o) => o.key === autoOutcomeRef.current)?.label ?? autoOutcomeRef.current } : null);
  }, [running, market, publishAuto]);
  useEffect(() => () => publishAuto(null), [publishAuto]);

  const bal = spendable;
  const readout = amountMode === 'payout' ? stakeCents : payoutForStake(stakeCents, primaryProb, PAYOUT_FACTOR);

  // ── Trade types (phones: a scrollable row above the chart; desktop: pills in the console). The
  //    grid button opens the full "Trade types" sheet (owner's mock). ──
  const pickType = (id: TradeTypeId) => {
    halt();
    if (id === 'multipliers') { setMulti(true); return; }
    setMulti(false); setMarket(id);
  };
  const tabs: { id: TradeTypeId; label: string; console: string }[] = [
    ...MARKETS.map((m) => ({ id: m.id as TradeTypeId, label: m.label, console: m.label.replace('Matches/Differs', 'Match / Differ').replace('Even/Odd', 'Even / Odd').replace('Over/Under', 'Over / Under') })),
    ...(isDemo ? [{ id: 'multipliers' as TradeTypeId, label: 'Multipliers', console: 'Multipliers' }] : []),
  ];
  const currentType: TradeTypeId = multi ? 'multipliers' : market;
  // Phones: keep the active trade type visible in the scrolling tab row (e.g. after picking from the sheet).
  const topTabsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = topTabsRef.current;
    const el = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && el) row.scrollTo({ left: Math.max(0, el.offsetLeft - row.offsetLeft - 8), behavior: 'smooth' });
  }, [currentType, tabs.length]);
  const marketTabs = (variant: 'top' | 'console') => (
    <div className={cn('flex items-center', variant === 'top' ? 'gap-1.5 lg:hidden' : 'hidden gap-2 lg:flex')}>
      {variant === 'top' ? (
        <button type="button" onClick={() => setTypesOpen(true)} aria-label="All trade types" title="All trade types"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border text-muted transition hover:text-fg">
          <DIcon name="apps" className="h-4 w-4" />
        </button>
      ) : null}
      <div ref={variant === 'top' ? topTabsRef : undefined} className={cn('min-w-0 flex-1 gap-1.5',
        variant === 'top' ? cn('flex', tabs.length > 3 && 'overflow-x-auto [scrollbar-width:none]') : cn('grid', tabs.length > 3 ? 'grid-cols-2' : 'grid-cols-3'))}>
        {tabs.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={currentType === m.id}
            onClick={() => pickType(m.id)}
            className={cn(
              'border font-medium transition',
              tabs.length > 3 && variant === 'top' ? 'shrink-0 px-3' : 'min-w-0 flex-1 truncate',
              variant === 'top' ? 'rounded-xl py-2 text-[clamp(11px,3.3vw,13px)]' : 'rounded-lg py-2 text-[12px]',
              currentType === m.id ? 'border-accent bg-accent/10 text-fg' : 'border-border text-muted hover:text-fg',
            )}
          >
            {variant === 'console' ? m.console : m.label}
          </button>
        ))}
      </div>
    </div>
  );

  const toolBtn = (label: string, icon: Parameters<typeof DIcon>[0]['name'], onClick: () => void, active = false) => (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={active}
      className={cn('grid h-7 w-7 place-items-center rounded-md transition', active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
      <DIcon name={icon} className="h-4 w-4" />
    </button>
  );
  const roundBtn = (label: string, icon: Parameters<typeof DIcon>[0]['name'], onClick: () => void) => (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="grid h-7 w-7 place-items-center rounded-full border border-border bg-bg/80 text-muted backdrop-blur transition hover:text-fg">
      <DIcon name={icon} className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto overflow-x-hidden overscroll-contain pb-2 lg:flex-row lg:gap-0 lg:overflow-hidden lg:pb-0">
      {/* Left rail (desktop): Open / Closed / History + session summary */}
      {railOpen ? (
        <aside className="hidden border-r border-border bg-surface lg:flex lg:w-[260px] lg:shrink-0 lg:flex-col">
          <PositionsPanel onClose={() => setRailOpen(false)} className="h-full" />
        </aside>
      ) : null}

      {/* Center: chart + digit statistics */}
      <div className="flex shrink-0 flex-col gap-2 lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink lg:gap-3 lg:p-3">
        {marketTabs('top')}

        <div className="relative flex h-[34vh] min-h-[220px] shrink-0 flex-col overflow-visible rounded-xl border border-border bg-bg lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
          {/* toolbar: timeframe · instrument · share */}
          <div className="absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-2 lg:p-3">
            {!railOpen ? (
              <button type="button" onClick={() => setRailOpen(true)} className="hidden h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12px] font-semibold text-fg lg:flex">
                <DIcon name="clock" className="h-4 w-4" />Positions
              </button>
            ) : null}
            <div ref={tfRef} className="relative shrink-0">
              <button type="button" onClick={() => setTfOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={tfOpen} aria-label="Timeframe"
                className="grid h-9 w-9 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-[12px] font-bold text-accent transition hover:border-accent/60">
                {tf.label}
              </button>
              {tfOpen ? (
                <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] z-30 w-28 rounded-lg border border-border bg-surface-2 p-1 shadow-2xl">
                  {TIMEFRAMES.map((o) => (
                    <button key={o.label} type="button" role="option" aria-selected={o.label === tf.label} onClick={() => { setTf(o); setTfOpen(false); }}
                      className={cn('block w-full rounded-md px-2 py-1.5 text-left text-xs font-semibold transition', o.label === tf.label ? 'bg-accent/15 text-fg' : 'text-muted hover:text-fg')}>
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="min-w-0">
              <VolatilitySelector wide instrument={instrument} price={snap.price || null} changePct={snap.changePct}
                onSelect={(i) => { setInstId(i.id); halt(); }} />
            </div>
            <span title={`${shareLabel} over the last ${WINDOW} ticks`}
              className="ml-auto shrink-0 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-semibold tabular-nums text-fg">
              {Math.round(sharePct)}%
            </span>
          </div>

          {/* chart */}
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl pt-12 lg:pt-14">
            <DerivChart
              ref={chartRef}
              getTicks={getInstrumentTicks}
              getLastTick={getLastInstrumentTick}
              resetKey={instrumentResetKey}
              barSpacing={tf.barSpacing}
              markers={chartMarkers}
              variant={chartVariant}
              drawMode={drawMode}
              onLineDrawn={() => setDrawMode(false)}
            />
            {/* drawing tools (desktop) */}
            <div className="absolute left-2 top-14 z-10 hidden flex-col gap-1 lg:flex">
              {toolBtn('Line chart', 'line', () => setChartVariant('line'), chartVariant === 'line')}
              {toolBtn('Area chart', 'bars', () => setChartVariant('area'), chartVariant === 'area')}
              {toolBtn(drawMode ? 'Click the chart to draw a line' : 'Draw a horizontal line (double-click to clear)', 'pencil', () => setDrawMode((v) => !v), drawMode)}
              {toolBtn('Download chart', 'download', () => chartRef.current?.download(`${instrument.short.replace(/\s+/g, '-')}.png`))}
            </div>
            {/* zoom (desktop) */}
            <div className="absolute bottom-8 left-2 z-10 hidden flex-col items-center gap-1.5 lg:flex">
              {roundBtn('Zoom in', 'plus', () => chartRef.current?.zoomIn())}
              {roundBtn('Show all', 'crosshair', () => chartRef.current?.fit())}
              {roundBtn('Zoom out', 'minus', () => chartRef.current?.zoomOut())}
              <button type="button" onClick={() => { chartRef.current?.followLive(); chartRef.current?.clearLines(); }} aria-label="Back to live price" title="Back to live price"
                className="mt-1 grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-fg shadow-[0_0_14px_-4px_var(--pp-accent)]">
                <DIcon name="refresh" className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </div>
            {pendingView ? (
              <div className="pointer-events-none absolute inset-x-0 top-14 mx-auto flex w-fit items-center gap-2 rounded-full border border-accent/40 bg-surface/90 px-3 py-1 text-[12px] font-semibold text-fg shadow-lg backdrop-blur">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                {pendingView.label} · {amt.text(pendingView.stakeCents)}
              </div>
            ) : null}
            {flash ? (
              <div className={cn('pointer-events-none absolute inset-x-0 top-14 mx-auto w-fit rounded-full px-3.5 py-1 text-[13px] font-bold shadow-lg', flash.won ? 'bg-up text-white' : 'bg-down text-white')}>
                {flash.won ? 'WON ' : 'LOST '}{amt.signed(flash.delta)}
              </div>
            ) : null}
          </div>
        </div>

        {!multi ? <DigitHeatmap freqs={snap.freqs} current={snap.digit} /> : null}
      </div>

      {/* Right: trading console */}
      <div className="flex shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[340px] lg:shrink-0 lg:gap-3 lg:overflow-y-auto lg:border-l lg:border-border lg:bg-surface lg:p-4">
        <div className="hidden items-center justify-between lg:flex">
          <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">Trading mode</span>
          <span className="text-[10px] tabular-nums text-muted">Bal {amt.prefix}{amt.num(bal)}</span>
        </div>
        <button type="button" onClick={() => setTypesOpen(true)} aria-label="All trade types"
          className="hidden items-center gap-2 self-start text-[12px] font-semibold text-accent hover:underline lg:flex">
          <DIcon name="apps" className="h-3.5 w-3.5" />All trade types
        </button>


{!multi ? (<>
        {/* AUTO / MANUAL */}
        <div className="flex rounded-xl border border-border bg-bg/60 p-1">
          {(['auto', 'manual'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m}
              onClick={() => { setMode(m); halt(); }}
              className={cn('flex-1 rounded-lg py-2.5 text-[13px] font-semibold uppercase tracking-wide transition',
                mode === m ? 'bg-accent text-accent-fg shadow-[0_2px_16px_-4px_var(--pp-accent)]' : 'text-muted hover:text-fg')}>
              {m}
            </button>
          ))}
        </div>

</>) : null}
        {marketTabs('console')}

        {multi ? (
          <MultipliersPanel getLastTick={getLastInstrumentTick} resetKey={instId} instrumentId={instId} minStakeCents={minStakeCents} />
        ) : (<>

        {/* SELECT DIGIT — barrier (Over/Under) or prediction (Match/Differ) */}
        {needsDigit ? (
          <div className="rounded-xl border border-border bg-bg/40 px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Select digit</span>
              <span className="text-[12px] font-bold tabular-nums text-accent">{selectorValue}</span>
            </div>
            <div className="grid grid-cols-10 gap-1">
              {Array.from({ length: 10 }, (_, d) => (
                <button key={d} type="button" onClick={() => onSelectDigit(d)} aria-pressed={selectorValue === d}
                  aria-label={`${market === 'overunder' ? 'Barrier' : 'Prediction'} digit ${d}`}
                  className={cn('grid aspect-square place-items-center rounded-md border text-[12px] font-semibold tabular-nums transition',
                    selectorValue === d ? 'border-accent bg-accent/15 text-fg shadow-[0_0_10px_-3px_var(--pp-accent)]' : 'border-border text-muted hover:text-fg')}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* STAKE AMOUNT + Stake/Payout (desktop; on phones the caption in the stepper toggles it) */}
        <div className="hidden items-center justify-between lg:flex">
          <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">{amountMode === 'payout' ? 'Payout amount' : 'Stake amount'}</span>
          <div className="flex rounded-lg border border-border bg-bg/60 p-0.5 text-[11px] font-semibold">
            {(['stake', 'payout'] as const).map((mm) => (
              <button key={mm} type="button" aria-pressed={amountMode === mm}
                onClick={() => {
                  if (mm === amountMode) return;
                  if (mm === 'payout') setPayoutInput(toAmountStr(payoutForStake(stakeCents, primaryProb, PAYOUT_FACTOR)));
                  else setStake(toAmountStr(stakeCents));
                  setAmountMode(mm);
                }}
                className={cn('rounded-md px-2.5 py-1 capitalize transition', amountMode === mm ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
                {mm}
              </button>
            ))}
          </div>
        </div>

        {/* stepper */}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-bg/40 px-3 py-2.5">
          <button type="button" onClick={() => stepStake(-1)} aria-label="Decrease amount"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted transition hover:text-fg"><DIcon name="minus" className="h-4 w-4" /></button>
          <div className="flex-1 text-center">
            <button type="button" onClick={() => {
                const mm = amountMode === 'payout' ? 'stake' : 'payout';
                if (mm === 'payout') setPayoutInput(toAmountStr(payoutForStake(stakeCents, primaryProb, PAYOUT_FACTOR)));
                else setStake(toAmountStr(stakeCents));
                setAmountMode(mm);
              }}
              title="Switch between entering a stake and a target payout"
              className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted lg:hidden">
              {amountMode === 'payout' ? 'Payout ⇄' : 'Stake ⇄'}
            </button>
            <div className="flex items-baseline justify-center gap-3">
              <span className="text-[15px] font-semibold text-accent">{symbol}</span>
              <input inputMode="decimal" value={amountMode === 'payout' ? payoutInput : stake}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
                  if (amountMode === 'payout') setPayoutInput(v); else setStake(v);
                }}
                aria-label={amountMode === 'payout' ? 'Target payout' : 'Stake amount'}
                className="w-24 bg-transparent text-center font-mono text-[22px] font-bold tabular-nums text-fg outline-none" />
            </div>
          </div>
          <button type="button" onClick={() => stepStake(1)} aria-label="Increase amount"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted transition hover:text-fg"><DIcon name="plus" className="h-4 w-4" /></button>
        </div>

        {/* presets */}
        <div className="grid grid-cols-6 gap-1.5">
          {presets.map((q) => {
            const active = Number(amountMode === 'payout' ? payoutInput : stake) === q;
            const belowMin = amountMode === 'stake' && toKesCents(q) < minStakeCents;
            return (
              <button key={q} type="button" disabled={belowMin}
                onClick={() => (amountMode === 'payout' ? setPayoutInput(String(q)) : setStake(String(q)))}
                className={cn('rounded-lg border py-1.5 text-[clamp(10.5px,2.8vw,12px)] font-medium tabular-nums transition disabled:cursor-not-allowed disabled:opacity-30',
                  active ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-bg/40 text-muted hover:text-fg')}>
                {isForeign ? `${symbol}${q}` : q >= 1000 ? `${q / 1000}k` : q}
              </button>
            );
          })}
        </div>

        {/* resolved readout (desktop) */}
        <div className="hidden items-center justify-between rounded-xl border border-border bg-bg/40 px-4 py-3.5 lg:flex">
          <span className="text-[13px] text-muted">{amountMode === 'payout' ? 'Stake' : 'Payout'}</span>
          <span className="font-mono text-[18px] font-bold tabular-nums text-fg">{amt.num(readout)} <span className="text-[11px] font-medium text-muted">{amt.code}</span></span>
        </div>

        {stakeHint ? <p className="text-center text-[11px] text-warn">{stakeHint}</p> : null}

        {/* AUTO settings */}
        {mode === 'auto' ? (
          <div className="grid grid-cols-3 gap-2">
            <BotField icon="target" label="Target" prefix={symbol} value={targetProfit} onChange={setTargetProfit} tone="up" />
            <BotField icon="stop" label="Stop loss" prefix={symbol} value={stopLoss} onChange={setStopLoss} tone="down" />
            <BotField icon="mult" label="Mult" prefix="×" value={multiplier} onChange={setMultiplier} />
          </div>
        ) : null}

        {/* Buy buttons: stacked cards on desktop, side by side on phones. While AUTO runs, STOP takes the first slot. */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-1 lg:gap-3">
          {(running
            ? [{ key: 'stop' as const, label: 'Stop' }, ...[primary, secondary].filter((o) => o.key !== autoOutcomeRef.current)]
            : [primary, secondary]
          ).map((o, i) => {
            if (o.key === 'stop') {
              return (
                <button key="stop" type="button" onClick={() => stopAuto('user')} aria-label="Stop auto trading"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-warn py-4 text-[17px] font-bold uppercase text-black shadow-[0_0_24px_-8px_var(--pp-warn)] transition hover:brightness-105 lg:py-5">
                  <span className="h-3.5 w-3.5 rounded-full bg-black" />Stop
                </button>
              );
            }
            const outcome = o.key as Outcome;
            const meta = ctaMeta(outcome);
            const isUp = outcome === primary.key;
            return (
              <button key={outcome} type="button"
                aria-label={`Buy ${o.label}: pays ${amt.text(meta.ret)} (${meta.profitPct.toFixed(2)}%)`}
                disabled={meta.disabled || running || (!stakeValid)}
                onClick={() => onCta(outcome)}
                className={cn(
                  'group rounded-2xl border-[1.5px] text-left transition disabled:opacity-40',
                  isUp ? 'border-up bg-up/10 hover:bg-up/15' : 'border-down bg-down/10 hover:bg-down/15',
                  loadedOutcome === outcome ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : '',
                  i === 0 && running ? '' : '',
                )}>
                {/* desktop card */}
                <span className="hidden items-center gap-3 px-4 py-4 lg:flex">
                  <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', isUp ? 'bg-up/20 text-up' : 'bg-down/20 text-down')}>
                    <DIcon name={isUp ? 'grid' : 'triangle'} className="h-5 w-5" />
                  </span>
                  <span className={cn('shrink-0 text-[19px] font-bold', isUp ? 'text-up' : 'text-down')}>{o.label}</span>
                  <span className="min-w-0 flex-1 text-right">
                    <FitText minPx={10} className="font-mono text-[13px] font-semibold tabular-nums text-fg">{amt.text(meta.ret)}</FitText>
                    <span className={cn('block font-mono text-[15px] font-bold tabular-nums', isUp ? 'text-up' : 'text-down')}>{meta.profitPct.toFixed(2)}%</span>
                  </span>
                </span>
                {/* phone card */}
                <span className="flex items-center justify-between gap-2 px-3.5 py-3 lg:hidden">
                  <span className="shrink-0">
                    <span className={cn('block text-[17px] font-bold leading-tight', isUp ? 'text-up' : 'text-down')}>{o.label}</span>
                    <span className="block text-[11px] font-medium tabular-nums text-muted">{meta.profitPct.toFixed(2)}%</span>
                  </span>
                  <span className="min-w-0 flex-1 text-right">
                    <FitText minPx={10} className="font-mono text-[15px] font-bold tabular-nums text-fg">{`${amt.prefix}${amt.num(meta.ret)}`}</FitText>
                    <span className="block text-[11px] text-muted">Payout</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        </>)}
      </div>

      <EntryScanner currentInstrumentId={instId} busy={running} onApply={applyScan} />
      {typesOpen ? <TradeTypesSheet value={currentType} demo={isDemo} onPick={pickType} onClose={() => setTypesOpen(false)} /> : null}
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
  const cls = cn('h-3 w-3', kind === 'target' ? 'text-up' : kind === 'stop' ? 'text-down' : 'text-accent');
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
    <label className="flex flex-col items-center gap-1 rounded-xl border border-border bg-bg/40 px-2 py-2.5 text-center">
      <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted">
        <BotFieldIcon kind={icon} />
        {label}
      </span>
      <span className="flex items-baseline justify-center gap-0.5">
        <span className={cn('text-[10px] font-semibold', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-accent')}>{prefix}</span>
        <input
          inputMode="decimal"
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
          className="w-14 bg-transparent text-center font-mono text-[14px] font-semibold tabular-nums text-fg outline-none"
        />
      </span>
    </label>
  );
}
