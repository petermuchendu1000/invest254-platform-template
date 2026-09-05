'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { DigitHeatmap } from '@/components/game/digits/DigitHeatmap';
import { MultipliersPanel } from '@/components/game/digits/MultipliersPanel';
import { DerivChart } from '@/components/game/digits/DerivChart';
import { VolatilitySelector } from '@/components/game/digits/VolatilitySelector';
import { useInstrument } from '@/lib/game/useInstrument';
import { instrumentById, DEFAULT_INSTRUMENT_ID, type Instrument } from '@/lib/game/instruments';
import { useDisplayMoney } from '@/lib/money';
import { useWallet } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';

// ── Contract model ────────────────────────────────────────────────────────────────────────────
const MARKETS = [
  { id: 'matchesdiffers', label: 'Matches/Differs' },
  { id: 'evenodd', label: 'Even/Odd' },
  { id: 'overunder', label: 'Over/Under' },
] as const;
type Market = (typeof MARKETS)[number]['id'];
type TradeType = 'digits' | 'multipliers';
type Outcome = 'even' | 'odd' | 'over' | 'under' | 'matches' | 'differs';

// House factor: total return = stake * (PAYOUT_FACTOR / winProbability). 0.976 reproduces the
// tagoption/Deriv Even-Odd figure exactly (0.976 / 0.5 = 1.952 → 95.2% profit).
const PAYOUT_FACTOR = 0.976;
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

function isWin(outcome: Outcome, digit: number, barrier: number, pick: number): boolean {
  switch (outcome) {
    case 'even':
      return digit % 2 === 0;
    case 'odd':
      return digit % 2 === 1;
    case 'over':
      return digit > barrier;
    case 'under':
      return digit < barrier;
    case 'matches':
      return digit === pick;
    case 'differs':
      return digit !== pick;
  }
  return false;
}

const outcomesFor = (m: Market): [{ key: Outcome; label: string }, { key: Outcome; label: string }] =>
  m === 'evenodd'
    ? [{ key: 'even', label: 'Even' }, { key: 'odd', label: 'Odd' }]
    : m === 'overunder'
      ? [{ key: 'over', label: 'Over' }, { key: 'under', label: 'Under' }]
      : [{ key: 'matches', label: 'Matches' }, { key: 'differs', label: 'Differs' }];

type Pending = { stakeCents: number; profitCents: number; outcome: Outcome; barrier: number; pick: number; placedT: number };
type Result = { id: number; won: boolean; delta: number; label: string };

/** Deriv-style binary/digits trade surface (per-brand `tradeUi==='digits'`). */
export function DigitsTradeScreen() {
  const [instId, setInstId] = useState<string>(DEFAULT_INSTRUMENT_ID);
  const instrument: Instrument = instrumentById(instId);
  const { getTicks, getLastTick, resetKey } = useInstrument(instrument);
  const { fmt, symbol, isForeign, toKesCents } = useDisplayMoney();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const { data: wallet } = useWallet();
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  const [market, setMarket] = useState<Market>('evenodd');
  const [tradeType, setTradeType] = useState<TradeType>('digits');
  const [mode, setMode] = useState<'auto' | 'manual'>('manual');
  const [barrier, setBarrier] = useState(5); // Over/Under
  const [pick, setPick] = useState(0); // Matches/Differs

  const presets = useMemo(() => (isForeign ? [1, 5, 10, 25, 50, 100] : [50, 100, 200, 500, 1000, 5000]), [isForeign]);
  const step = isForeign ? 1 : 50;
  const [stake, setStake] = useState<string>(String(isForeign ? 10 : 200));
  const stakeCents = useMemo(() => {
    const n = Number.parseFloat(stake);
    return Number.isFinite(n) && n > 0 ? toKesCents(n) : 0;
  }, [stake, toKesCents]);

  // AUTO-bot params (display-currency units for money, plain number for the multiplier).
  const [targetProfit, setTargetProfit] = useState(isForeign ? '20' : '2000');
  const [stopLoss, setStopLoss] = useState(isForeign ? '10' : '1000');
  const [multiplier, setMultiplier] = useState('2');

  // Session state (PREVIEW — no real-money movement until the engine gains digit contracts).
  const [pnl, setPnl] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [flash, setFlash] = useState<{ won: boolean; delta: number } | null>(null);
  const [running, setRunning] = useState(false);

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
  const idRef = useRef(0);
  const pnlRef = useRef(0);
  pnlRef.current = pnl;

  const totalReturnCents = useCallback(
    (cents: number, outcome: Outcome) => Math.round((cents * PAYOUT_FACTOR) / winProbability(outcome, barrier)),
    [barrier],
  );

  const settle = useCallback((p: Pending, digit: number) => {
    const won = isWin(p.outcome, digit, p.barrier, p.pick);
    const delta = won ? p.profitCents : -p.stakeCents;
    lossStreakRef.current = won ? 0 : lossStreakRef.current + 1;
    setPnl((x) => x + delta);
    setFlash({ won, delta });
    idRef.current += 1;
    const label = `${p.outcome.toUpperCase()} · ${digit}`;
    setResults((r) => [{ id: idRef.current, won, delta, label }, ...r].slice(0, 8));
    window.setTimeout(() => setFlash(null), 900);
  }, []);

  const place = useCallback(
    (outcome: Outcome, cents: number) => {
      if (!Number.isFinite(cents) || cents <= 0) return false;
      if (!token || cents > spendable) {
        openDeposit({ amountCents: cents });
        return false;
      }
      if (winProbability(outcome, barrier) <= 0) return false;
      const ticks = getTicks();
      const last = ticks[ticks.length - 1];
      if (!last) return false;
      const ret = totalReturnCents(cents, outcome);
      pendingRef.current = { stakeCents: cents, profitCents: ret - cents, outcome, barrier, pick, placedT: last.t };
      return true;
    },
    [token, spendable, openDeposit, barrier, pick, getTicks, totalReturnCents],
  );

  // Live snapshot + settlement + AUTO-bot loop, all driven off the tick stream.
  useEffect(() => {
    const id = window.setInterval(() => {
      const ticks = getTicks();
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

      // Settle a pending contract on the first NEW tick after placement (1-tick contracts).
      const p = pendingRef.current;
      if (p && last.t > p.placedT) {
        settle(p, digit);
        pendingRef.current = null;
      }

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
        const next = Math.min(Math.round(base * Math.pow(mult, lossStreakRef.current)), spendable || base);
        place(autoOutcomeRef.current, next);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [getTicks, settle, place, stakeCents, spendable, multiplier, targetProfit, stopLoss, toKesCents]);

  const [primary, secondary] = outcomesFor(market);
  const isMultipliers = tradeType === 'multipliers';
  const needsDigit = !isMultipliers && market !== 'evenodd';
  const selectorValue = market === 'overunder' ? barrier : pick;
  const onSelectDigit = (d: number) => (market === 'overunder' ? setBarrier(d) : setPick(d));

  const stepStake = (dir: 1 | -1) => {
    const n = Math.max(0, (Number.parseFloat(stake) || 0) + dir * step);
    setStake(isForeign ? String(Math.round(n * 100) / 100) : String(Math.round(n)));
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
    place(outcome, stakeCents);
  };

  const ctaMeta = (o: Outcome) => {
    const prob = winProbability(o, barrier);
    const disabled = prob <= 0;
    const profitPct = prob > 0 ? (PAYOUT_FACTOR / prob - 1) * 100 : 0;
    const ret = prob > 0 ? totalReturnCents(stakeCents, o) : 0;
    return { disabled, profitPct, ret };
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-2.5 sm:gap-3 sm:p-3">
      {/* Trade type — Digits vs Multipliers (Multipliers is its own type, not a digit sub-market) */}
      <div className="flex gap-1 rounded-lg border border-border bg-surface-2 p-0.5">
        {(['digits', 'multipliers'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTradeType(t); if (running) setRunning(false); }}
            className={cn(
              'flex-1 rounded-md py-1.5 text-[13px] font-semibold capitalize transition',
              tradeType === t ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Chart panel — Deriv-style axis chart with the volatility breadcrumb floating top-left */}
      <div className="relative min-h-[168px] flex-1 overflow-hidden rounded-xl border border-border bg-surface-2">
        <DerivChart getTicks={getTicks} getLastTick={getLastTick} resetKey={resetKey} />
        <div className="absolute left-2 top-2 z-20">
          <VolatilitySelector
            instrument={instrument}
            price={snap.price || null}
            changePct={snap.changePct}
            onSelect={(i) => { setInstId(i.id); if (running) setRunning(false); }}
          />
        </div>
        {!isMultipliers && snap.digit !== null ? (
          <span className="absolute right-2 bottom-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
            {snap.digit}
          </span>
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

      {/* Digit sub-market (Digits type only) */}
      {!isMultipliers ? (
        <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface-2 p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {MARKETS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { setMarket(m.id); if (running) setRunning(false); }}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-semibold transition',
                market === m.id ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* Live digit heatmap (also the digit picker for Matches/Differs & Over/Under) */}
      {!isMultipliers ? (
        <>
          <DigitHeatmap
            freqs={snap.freqs}
            current={snap.digit}
            selected={needsDigit ? selectorValue : null}
            selectable={needsDigit}
            onSelect={onSelectDigit}
          />
          {needsDigit ? (
            <p className="-mt-1 text-center text-[11px] text-muted">
              {market === 'overunder' ? 'Barrier digit' : 'Prediction digit'}: <span className="font-semibold text-fg">{selectorValue}</span> — tap a digit to change
            </p>
          ) : null}
        </>
      ) : null}

      {/* Scrollable console */}
      <div className="flex min-h-0 flex-col gap-3">
        {isMultipliers ? (
          <MultipliersPanel getLastTick={getLastTick} resetKey={resetKey} />
        ) : (
        <>
        {/* AUTO / MANUAL */}
        <div className="flex rounded-xl border border-border bg-surface-2 p-1">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); if (running) setRunning(false); }}
              className={cn(
                'flex-1 rounded-lg py-2 text-sm font-semibold uppercase tracking-wide transition',
                mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Stake stepper */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => stepStake(-1)} aria-label="Decrease stake"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-base font-bold text-fg hover:border-accent/60">−</button>
          <div className="flex-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-center">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Stake</div>
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-sm font-bold text-muted">{symbol}</span>
              <input
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                aria-label="Stake amount"
                className="w-24 bg-transparent text-center text-xl font-black tabular-nums text-fg outline-none"
              />
            </div>
          </div>
          <button type="button" onClick={() => stepStake(1)} aria-label="Increase stake"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-base font-bold text-fg hover:border-accent/60">+</button>
        </div>

        {/* Presets */}
        <div className="grid grid-cols-6 gap-1.5">
          {presets.map((q) => {
            const active = Number(stake) === q;
            return (
              <button
                key={q}
                type="button"
                onClick={() => setStake(String(q))}
                className={cn(
                  'rounded-lg border py-2 text-xs font-semibold tabular-nums transition',
                  active ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-surface-2 text-muted hover:text-fg',
                )}
              >
                {isForeign ? `${symbol}${q}` : q >= 1000 ? `${q / 1000}k` : q}
              </button>
            );
          })}
        </div>

        {/* AUTO-bot params */}
        {mode === 'auto' ? (
          <div className="grid grid-cols-3 gap-2">
            <BotField label="Target profit" prefix={symbol} value={targetProfit} onChange={setTargetProfit} tone="up" />
            <BotField label="Stop loss" prefix={symbol} value={stopLoss} onChange={setStopLoss} tone="down" />
            <BotField label="Multiplier" prefix="×" value={multiplier} onChange={setMultiplier} />
          </div>
        ) : null}

        {/* Dual payout CTAs */}
        <div className="grid grid-cols-2 gap-2">
          {[primary, secondary].map((o, i) => {
            const meta = ctaMeta(o.key);
            const isUp = i === 0;
            const active = running && autoOutcomeRef.current === o.key;
            return (
              <button
                key={o.key}
                type="button"
                disabled={meta.disabled}
                onClick={() => onCta(o.key)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl px-3.5 py-2.5 text-left text-white transition disabled:opacity-40',
                  isUp ? 'bg-up hover:opacity-90' : 'bg-down hover:opacity-90',
                  active ? 'ring-2 ring-white/70' : '',
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-sm font-extrabold">{mode === 'auto' && active ? 'Stop' : o.label}</span>
                  <span className="text-[13px] font-bold tabular-nums">{fmt(meta.ret)}</span>
                </div>
                <span className="text-[10px] font-semibold text-white/85">{meta.profitPct.toFixed(1)}% payout</span>
              </button>
            );
          })}
        </div>

        {/* Session ledger (preview) */}
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>Session P/L</span>
            <span className={cn('text-sm font-bold tabular-nums', pnl >= 0 ? 'text-up' : 'text-down')}>
              {pnl >= 0 ? '+' : ''}{fmt(pnl)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {results.slice(0, 6).map((r) => (
              <span key={r.id} className={cn('h-2.5 w-2.5 rounded-full', r.won ? 'bg-up' : 'bg-down')} title={`${r.label} · ${r.won ? '+' : ''}${fmt(r.delta)}`} />
            ))}
            {results.length === 0 ? <span className="text-[11px] text-muted">no trades yet</span> : null}
          </div>
        </div>
        <p className="text-center text-[10px] text-muted">Preview mode · outcomes settle against the live tick stream (no real-money movement yet).</p>
        </>
        )}
      </div>
    </div>
  );
}

function BotField({
  label,
  prefix,
  value,
  onChange,
  tone,
}: {
  label: string;
  prefix: string;
  value: string;
  onChange: (v: string) => void;
  tone?: 'up' | 'down';
}) {
  return (
    <label className="flex flex-col gap-1 rounded-xl border border-border bg-surface-2 px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</span>
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
