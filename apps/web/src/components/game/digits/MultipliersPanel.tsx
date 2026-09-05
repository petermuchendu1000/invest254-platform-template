'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { InstrumentTick } from '@/lib/game/useInstrument';
import { useDisplayMoney } from '@/lib/money';
import { useWallet } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';

// Deriv Multipliers: MULTUP/MULTDOWN. P/L = ±(price move %) × multiplier × stake, loss capped at
// the stake (stop-out at 100% loss). Optional Take Profit / Stop Loss auto-close; optional Deal
// Cancellation refunds the stake within a window for a fee (and auto-refunds if stop-out would hit
// during that window — Deriv disables Stop Loss while Deal Cancellation is active).
const MULTIPLIERS = [100, 200, 300, 400, 500, 1000];
const DC_WINDOWS = [
  { label: 'Off', min: 0 },
  { label: '5m', min: 5 },
  { label: '15m', min: 15 },
  { label: '60m', min: 60 },
];
type Dir = 'up' | 'down';
type CloseReason = 'manual' | 'tp' | 'sl' | 'stopout' | 'cancel';

interface Position {
  dir: Dir;
  entry: number;
  stakeCents: number;
  multiplier: number;
  tpCents: number | null;
  slCents: number | null;
  dcUntil: number | null;
  dcFeeCents: number;
  openedT: number;
}

const num = (s: string) => { const n = Number.parseFloat(s); return Number.isFinite(n) ? n : 0; };
const dcFeeCents = (stakeCents: number, min: number) => (min <= 0 ? 0 : Math.round(stakeCents * 0.02 * Math.sqrt(min)));

export function MultipliersPanel({ getLastTick, resetKey }: { getLastTick: () => InstrumentTick | null; resetKey: string }) {
  const { fmt, symbol, isForeign, toKesCents } = useDisplayMoney();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const { data: wallet } = useWallet();
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  const [stake, setStake] = useState<string>(String(isForeign ? 10 : 200));
  const [multiplier, setMultiplier] = useState(100);
  const [tpOn, setTpOn] = useState(false);
  const [tp, setTp] = useState(isForeign ? '5' : '500');
  const [slOn, setSlOn] = useState(false);
  const [sl, setSl] = useState(isForeign ? '5' : '500');
  const [dcMin, setDcMin] = useState(0);

  const [position, setPosition] = useState<Position | null>(null);
  const [livePnl, setLivePnl] = useState(0);
  const [price, setPrice] = useState<number | null>(null);
  const [sessionPnl, setSessionPnl] = useState(0);
  const [flash, setFlash] = useState<{ pnl: number; reason: CloseReason } | null>(null);

  const posRef = useRef<Position | null>(null);
  posRef.current = position;

  const stakeCents = num(stake) > 0 ? toKesCents(num(stake)) : 0;
  const dcActive = dcMin > 0;
  const feePreview = dcFeeCents(stakeCents, dcMin);

  const pnlOf = (p: Position, cur: number): number => {
    const movePct = (cur - p.entry) / p.entry;
    const signed = p.dir === 'up' ? movePct : -movePct;
    return Math.round(signed * p.multiplier * p.stakeCents);
  };
  const stopoutPrice = (p: Position) => (p.dir === 'up' ? p.entry * (1 - 1 / p.multiplier) : p.entry * (1 + 1 / p.multiplier));

  const close = useCallback((p: Position, cur: number, reason: CloseReason) => {
    let realized: number;
    if (reason === 'cancel') realized = -p.dcFeeCents; // stake refunded, only the DC fee is lost
    else if (reason === 'stopout') realized = -p.stakeCents;
    else if (reason === 'tp' && p.tpCents != null) realized = p.tpCents;
    else if (reason === 'sl' && p.slCents != null) realized = -p.slCents;
    else realized = Math.max(-p.stakeCents, pnlOf(p, cur));
    posRef.current = null;
    setPosition(null);
    setLivePnl(0);
    setSessionPnl((x) => x + realized);
    setFlash({ pnl: realized, reason });
    window.setTimeout(() => setFlash(null), 1400);
  }, []);

  // Live P/L + auto-close conditions, driven off the instrument tick stream.
  useEffect(() => {
    const id = window.setInterval(() => {
      const last = getLastTick();
      if (!last) return;
      const cur = last.rate;
      setPrice(cur);
      const p = posRef.current;
      if (!p) return;
      const pnl = pnlOf(p, cur);
      const now = Date.now();
      const dcLive = p.dcUntil != null && now < p.dcUntil;
      // Stop-out (100% loss). With an active DC window this auto-cancels (stake refunded).
      if (pnl <= -p.stakeCents) { close(p, cur, dcLive ? 'cancel' : 'stopout'); return; }
      if (p.tpCents != null && pnl >= p.tpCents) { close(p, cur, 'tp'); return; }
      if (!dcLive && p.slCents != null && pnl <= -p.slCents) { close(p, cur, 'sl'); return; }
      setLivePnl(Math.max(-p.stakeCents, pnl));
    }, 200);
    return () => window.clearInterval(id);
  }, [getLastTick, close]);

  // Switching the instrument realises any open position at the current price (its stream changed).
  useEffect(() => {
    const p = posRef.current;
    const last = getLastTick();
    if (p && last) close(p, last.rate, 'manual');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const stepStake = (d: 1 | -1) => {
    const s = Math.max(0, num(stake) + d * (isForeign ? 1 : 50));
    setStake(isForeign ? String(Math.round(s * 100) / 100) : String(Math.round(s)));
  };

  const open = (dir: Dir) => {
    if (position) return;
    if (!Number.isFinite(stakeCents) || stakeCents <= 0) return;
    if (!token || stakeCents > spendable) { openDeposit({ amountCents: stakeCents }); return; }
    const last = getLastTick();
    if (!last) return;
    const p: Position = {
      dir,
      entry: last.rate,
      stakeCents,
      multiplier,
      tpCents: tpOn && num(tp) > 0 ? toKesCents(num(tp)) : null,
      slCents: !dcActive && slOn && num(sl) > 0 ? toKesCents(num(sl)) : null,
      dcUntil: dcActive ? Date.now() + dcMin * 60_000 : null,
      dcFeeCents: dcActive ? feePreview : 0,
      openedT: Date.now(),
    };
    posRef.current = p;
    setPosition(p);
    setLivePnl(0);
  };

  const pnlPct = position ? (livePnl / position.stakeCents) * 100 : 0;
  const dcRemaining = position?.dcUntil ? Math.max(0, position.dcUntil - Date.now()) : 0;

  return (
    <div className="flex flex-col gap-3">
      {position ? (
        // ── Open position ─────────────────────────────────────────────────────────────────────
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
            {position.dcUntil && dcRemaining > 0 ? (
              <button type="button" onClick={() => { const l = getLastTick(); if (l) close(position, l.rate, 'cancel'); }}
                className="rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-bold text-fg hover:border-accent/60">
                Cancel · {Math.ceil(dcRemaining / 60000)}m left
              </button>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-3 py-2.5 text-center text-[11px] text-muted">No deal cancellation</div>
            )}
            <button type="button" onClick={() => { const l = getLastTick(); if (l) close(position, l.rate, 'manual'); }}
              className="rounded-xl bg-accent px-3 py-2.5 text-sm font-extrabold text-accent-fg hover:opacity-90">
              Close {livePnl >= 0 ? '+' : ''}{fmt(livePnl)}
            </button>
          </div>
        </div>
      ) : (
        // ── Setup ─────────────────────────────────────────────────────────────────────────────
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
            <button type="button" onClick={() => open('up')}
              className="flex flex-col items-start gap-0.5 rounded-xl bg-up px-3.5 py-2.5 text-left text-white transition hover:opacity-90">
              <span className="text-sm font-extrabold">Up</span>
              <span className="text-[10px] font-semibold text-white/85">Profit if price rises · x{multiplier}</span>
            </button>
            <button type="button" onClick={() => open('down')}
              className="flex flex-col items-start gap-0.5 rounded-xl bg-down px-3.5 py-2.5 text-left text-white transition hover:opacity-90">
              <span className="text-sm font-extrabold">Down</span>
              <span className="text-[10px] font-semibold text-white/85">Profit if price falls · x{multiplier}</span>
            </button>
          </div>
        </>
      )}

      {/* Session ledger (preview) */}
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
      <p className="text-center text-[10px] text-muted">Preview mode · P/L tracks the live tick stream (no real-money movement yet).</p>
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
