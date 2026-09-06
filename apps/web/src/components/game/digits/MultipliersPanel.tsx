'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { InstrumentTick } from '@/lib/game/useInstrument';
import { useGameSocket, type MultEvent, type MultOpenedData } from '@/lib/game/GameSocketProvider';
import { useDisplayMoney } from '@/lib/money';
import { useWallet } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';

// Deriv Multipliers: MULTUP/MULTDOWN. P/L = ±(price move %) × multiplier × stake, loss capped at
// the stake (stop-out at 100% loss). Optional Take Profit / Stop Loss auto-close; optional Deal
// Cancellation refunds the stake on a stop-out within its window (Deriv disables Stop Loss while
// Deal Cancellation is active). All lifecycle is SERVER-AUTHORITATIVE: the engine evaluates every
// instrument tick and pushes mult_update / mult_closed; in pool-mode brands the engine strips SL/DC,
// fixes TP, and refuses manual close (the decided path runs to its endpoint).
const MULTIPLIERS = [100, 200, 300, 400, 500, 1000];
const DC_WINDOWS = [
  { label: 'Off', min: 0 },
  { label: '5m', min: 5 },
  { label: '15m', min: 15 },
  { label: '60m', min: 60 },
];
type Dir = 'up' | 'down';
type CloseReason = 'manual' | 'tp' | 'sl' | 'stopout' | 'cancel';

const num = (s: string) => { const n = Number.parseFloat(s); return Number.isFinite(n) ? n : 0; };
const dcFeeCents = (stakeCents: number, min: number) => (min <= 0 ? 0 : Math.round(stakeCents * 0.02 * Math.sqrt(min)));

export function MultipliersPanel({ getLastTick, resetKey, instrumentId }: { getLastTick: () => InstrumentTick | null; resetKey: string; instrumentId: string }) {
  const { fmt, symbol, isForeign, toKesCents } = useDisplayMoney();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const { data: wallet } = useWallet();
  const { openMultiplier, closeMultiplier, onMultiplier } = useGameSocket();
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  const [stake, setStake] = useState<string>(String(isForeign ? 10 : 200));
  const [multiplier, setMultiplier] = useState(100);
  const [tpOn, setTpOn] = useState(false);
  const [tp, setTp] = useState(isForeign ? '5' : '500');
  const [slOn, setSlOn] = useState(false);
  const [sl, setSl] = useState(isForeign ? '5' : '500');
  const [dcMin, setDcMin] = useState(0);

  const [position, setPosition] = useState<MultOpenedData | null>(null);
  const [pendingDir, setPendingDir] = useState<Dir | null>(null);
  const [livePnl, setLivePnl] = useState(0);
  const [price, setPrice] = useState<number | null>(null);
  const [sessionPnl, setSessionPnl] = useState(0);
  const [flash, setFlash] = useState<{ pnl: number; reason: CloseReason } | null>(null);

  const posRef = useRef<MultOpenedData | null>(null);
  posRef.current = position;

  const stakeCents = num(stake) > 0 ? toKesCents(num(stake)) : 0;
  const dcActive = dcMin > 0;
  const feePreview = dcFeeCents(stakeCents, dcMin);

  // Server-authoritative lifecycle: opened ack, per-tick P/L, and the final close.
  useEffect(() => {
    const off = onMultiplier((e: MultEvent) => {
      if (e.type === 'opened') {
        setPendingDir(null);
        setPosition(e.data);
        setLivePnl(0);
        return;
      }
      const p = posRef.current;
      if (!p || e.data.positionId !== p.positionId) return;
      if (e.type === 'update') {
        setLivePnl(e.data.pnlCents);
        return;
      }
      // closed (manual / tp / sl / stopout / cancel) — authoritative P/L
      setPosition(null);
      setLivePnl(0);
      setSessionPnl((x) => x + e.data.pnlCents);
      setFlash({ pnl: e.data.pnlCents, reason: e.data.reason });
      window.setTimeout(() => setFlash(null), 1400);
    });
    return off;
  }, [onMultiplier]);

  // An open that never acked (engine refusal) → unblock the buttons.
  useEffect(() => {
    if (!pendingDir) return;
    const t = window.setTimeout(() => setPendingDir(null), 4000);
    return () => window.clearTimeout(t);
  }, [pendingDir]);

  // Current price readout for the stats row (display only; the engine evaluates server-side).
  useEffect(() => {
    const id = window.setInterval(() => {
      const last = getLastTick();
      if (last) setPrice(last.rate);
    }, 250);
    return () => window.clearInterval(id);
  }, [getLastTick]);

  const stepStake = (d: 1 | -1) => {
    const s = Math.max(0, num(stake) + d * (isForeign ? 1 : 50));
    setStake(isForeign ? String(Math.round(s * 100) / 100) : String(Math.round(s)));
  };

  const open = (dir: Dir) => {
    if (position || pendingDir) return;
    if (!Number.isFinite(stakeCents) || stakeCents <= 0) return;
    if (!token || stakeCents > spendable) { openDeposit({ amountCents: stakeCents }); return; }
    setPendingDir(dir);
    openMultiplier({
      instrumentId,
      dir,
      multiplier,
      stakeCents,
      tpCents: tpOn && num(tp) > 0 ? toKesCents(num(tp)) : null,
      slCents: !dcActive && slOn && num(sl) > 0 ? toKesCents(num(sl)) : null,
      ...(dcActive ? { dcMinutes: dcMin } : {}),
    });
  };

  const stopoutPrice = (p: MultOpenedData) => (p.dir === 'up' ? p.entry * (1 - 1 / p.multiplier) : p.entry * (1 + 1 / p.multiplier));
  const pnlPct = position ? (livePnl / position.stakeCents) * 100 : 0;
  const dcRemaining = position?.dcUntilMs ? Math.max(0, position.dcUntilMs - Date.now()) : 0;
  void resetKey; // an open position keeps streaming server-side even if the viewed instrument changes

  return (
    <div className="flex flex-col gap-3">
      {position ? (
        // ── Open position (server-acked) ──────────────────────────────────────────────────────────
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-3.5">
          <div className="flex items-center justify-between">
            <span className={cn('rounded-md px-2 py-0.5 text-xs font-bold text-white', position.dir === 'up' ? 'bg-up' : 'bg-down')}>
              {position.dir === 'up' ? 'UP' : 'DOWN'} · x{position.multiplier}
            </span>
            <span className="text-xs text-muted">Stake <span className="font-semibold text-fg">{fmt(position.stakeCents)}</span></span>
          </div>
          <div className="text-center">
            <div className={cn('text-2xl font-black tabular-nums', livePnl >= 0 ? 'text-up' : 'text-down')}>
              {livePnl >= 0 ? '+' : ''}{fmt(livePnl)}
            </div>
            <div className={cn('text-xs font-semibold tabular-nums', livePnl >= 0 ? 'text-up' : 'text-down')}>
              {livePnl >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Entry" value={position.entry.toFixed(2)} />
            <Stat label="Current" value={price != null ? price.toFixed(2) : '—'} />
            <Stat label="Stop out" value={stopoutPrice(position).toFixed(2)} tone="down" />
          </div>
          {position.tpCents != null || position.slCents != null ? (
            <div className="flex justify-center gap-2 text-[11px]">
              {position.tpCents != null ? <span className="rounded-md bg-up/15 px-2 py-0.5 font-semibold text-up">TP {fmt(position.tpCents)}</span> : null}
              {position.slCents != null ? <span className="rounded-md bg-down/15 px-2 py-0.5 font-semibold text-down">SL {fmt(position.slCents)}</span> : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {position.dcUntilMs && dcRemaining > 0 ? (
              <div className="rounded-xl border border-border bg-surface px-3 py-2.5 text-center text-[11px] text-muted">
                Deal cancellation · auto-refund on stop-out · {Math.ceil(dcRemaining / 60000)}m left
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-3 py-2.5 text-center text-[11px] text-muted">No deal cancellation</div>
            )}
            <button type="button" onClick={() => closeMultiplier(position.positionId)}
              className="rounded-xl bg-accent px-3 py-2.5 text-sm font-extrabold text-accent-fg hover:opacity-90">
              Close {livePnl >= 0 ? '+' : ''}{fmt(livePnl)}
            </button>
          </div>
        </div>
      ) : (
        // ── Setup ────────────────────────────────────────────────────────────────────────────────
        <>
          {/* Stake */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => stepStake(-1)} aria-label="Decrease stake"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-base font-bold text-fg hover:border-accent/60">−</button>
            <div className="flex-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-center">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Stake</div>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-sm font-bold text-muted">{symbol}</span>
                <input inputMode="decimal" value={stake} aria-label="Stake amount"
                  onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                  className="w-24 bg-transparent text-center text-2xl font-black tabular-nums text-fg outline-none" />
              </div>
            </div>
            <button type="button" onClick={() => stepStake(1)} aria-label="Increase stake"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-base font-bold text-fg hover:border-accent/60">+</button>
          </div>

          {/* Multiplier */}
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Multiplier</div>
            <div className="grid grid-cols-6 gap-1.5">
              {MULTIPLIERS.map((m) => (
                <button key={m} type="button" onClick={() => setMultiplier(m)}
                  className={cn('rounded-lg border py-2 text-xs font-semibold tabular-nums transition',
                    multiplier === m ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-surface-2 text-muted hover:text-fg')}>
                  x{m}
                </button>
              ))}
            </div>
          </div>

          {/* Take profit / Stop loss / Deal cancellation */}
          <div className="grid grid-cols-2 gap-2">
            <RiskField label="Take profit" prefix={symbol} on={tpOn} setOn={setTpOn} value={tp} setValue={setTp} tone="up" disabled={false} />
            <RiskField label="Stop loss" prefix={symbol} on={slOn} setOn={setSlOn} value={sl} setValue={setSl} tone="down" disabled={dcActive} disabledHint="Off while deal cancellation is on" />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Deal cancellation</span>
              {dcActive ? <span className="text-[11px] font-semibold text-muted">fee {fmt(feePreview)}</span> : null}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {DC_WINDOWS.map((w) => (
                <button key={w.label} type="button" onClick={() => setDcMin(w.min)}
                  className={cn('rounded-lg border py-2 text-xs font-semibold transition',
                    dcMin === w.min ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-surface-2 text-muted hover:text-fg')}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          {/* Up / Down */}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={pendingDir !== null} onClick={() => open('up')}
              className="flex flex-col items-start gap-0.5 rounded-xl bg-up px-3.5 py-2.5 text-left text-white transition hover:opacity-90 disabled:opacity-50">
              <span className="text-sm font-extrabold">{pendingDir === 'up' ? 'Opening…' : 'Up'}</span>
              <span className="text-[10px] font-semibold text-white/85">Profit if price rises · x{multiplier}</span>
            </button>
            <button type="button" disabled={pendingDir !== null} onClick={() => open('down')}
              className="flex flex-col items-start gap-0.5 rounded-xl bg-down px-3.5 py-2.5 text-left text-white transition hover:opacity-90 disabled:opacity-50">
              <span className="text-sm font-extrabold">{pendingDir === 'down' ? 'Opening…' : 'Down'}</span>
              <span className="text-[10px] font-semibold text-white/85">Profit if price falls · x{multiplier}</span>
            </button>
          </div>
        </>
      )}

      {/* Session ledger */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>Session P/L</span>
          <span className={cn('text-sm font-bold tabular-nums', sessionPnl >= 0 ? 'text-up' : 'text-down')}>
            {sessionPnl >= 0 ? '+' : ''}{fmt(sessionPnl)}
          </span>
        </div>
        {flash ? (
          <span className={cn('text-xs font-semibold', flash.pnl >= 0 ? 'text-up' : 'text-down')}>
            {flash.reason === 'cancel' ? 'Cancelled' : flash.reason === 'stopout' ? 'Stopped out' : flash.reason === 'tp' ? 'Take profit' : flash.reason === 'sl' ? 'Stop loss' : 'Closed'} {flash.pnl >= 0 ? '+' : ''}{fmt(flash.pnl)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'down' }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={cn('text-sm font-bold tabular-nums', tone === 'down' ? 'text-down' : 'text-fg')}>{value}</div>
    </div>
  );
}

function RiskField({
  label, prefix, on, setOn, value, setValue, tone, disabled, disabledHint,
}: {
  label: string; prefix: string; on: boolean; setOn: (b: boolean) => void; value: string; setValue: (v: string) => void;
  tone: 'up' | 'down'; disabled: boolean; disabledHint?: string;
}) {
  return (
    <div className={cn('rounded-xl border px-3 py-2', disabled ? 'border-border/60 opacity-50' : 'border-border', 'bg-surface-2')}>
      <label className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</span>
        <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={(e) => setOn(e.target.checked)} className="h-3.5 w-3.5 accent-current" />
      </label>
      {disabled ? (
        <div className="mt-1 text-[10px] text-muted">{disabledHint}</div>
      ) : (
        <div className={cn('mt-0.5 flex items-baseline gap-1', on ? '' : 'opacity-40')}>
          <span className="text-xs font-semibold text-muted">{prefix}</span>
          <input inputMode="decimal" value={value} disabled={!on}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
            className={cn('w-full bg-transparent text-base font-bold tabular-nums outline-none', tone === 'up' ? 'text-up' : 'text-down')} />
        </div>
      )}
    </div>
  );
}
