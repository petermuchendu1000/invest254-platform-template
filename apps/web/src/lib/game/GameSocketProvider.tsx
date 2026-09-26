'use client';

import {
  createContext,
  useMemo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatKes } from '@invest254/shared/money';
import { CURVE_AMPLITUDE, CURVE_BASE_RATE } from '@invest254/shared/config';
import { env } from '@/lib/env';
import { useBrand } from '@/lib/brand/BrandProvider';
import { wsUrlForSite } from '@/lib/brand/brand';
import { useSession } from '@/lib/auth/session';
import { useToast } from '@/lib/toast/ToastProvider';
import { useDisplayMoney } from '@/lib/money';
import { useOutcomeFx } from '@/lib/game/outcomeFx';
import type { WalletDto } from '@/lib/api/types';
import type {
  ConnStatus,
  Envelope,
  FairnessData,
  HelloData,
  OnlineData,
  Tick,
} from '@/lib/game/types';
import type {
  ActivePosition,
  BalanceData,
  OpenPositionInput,
  PositionOpenedData,
  PositionSettledData,
  PositionUpdateData,
  WsErrorData,
} from '@/lib/game/betting';
import type { InstrumentTick } from '@/lib/game/useInstrument';

const MAX_TICKS = 3000;

/** C→S: open a Deriv-style DIGIT contract on an instrument (server-authoritative). */
export interface OpenDigitInput { instrumentId: string; kind: string; target?: number; stakeCents: number; ticks?: number }
/** S→C: a settled digit contract (authoritative outcome + new balance). */
export interface DigitSettledData { positionId: string; instrumentId: string; index: number; digit: number; won: boolean; payoutCents: number; pnlCents: number; balance: number }
/** C→S: open a Deriv-style MULTIPLIER contract (server-authoritative). */
export interface OpenMultiplierInput { instrumentId: string; dir: 'up' | 'down'; multiplier: number; stakeCents: number; tpCents?: number | null; slCents?: number | null; dcMinutes?: number }
/** S→C: multiplier lifecycle events (opened ack / per-tick P&L / authoritative close). */
export interface MultOpenedData { positionId: string; instrumentId: string; entry: number; stakeCents: number; dir: 'up' | 'down'; multiplier: number; tpCents: number | null; slCents: number | null; dcUntilMs: number | null; dcFeeCents: number }
export interface MultUpdateData { positionId: string; instrumentId: string; index: number; pnlCents: number }
export interface MultClosedData { positionId: string; reason: 'manual' | 'tp' | 'sl' | 'stopout' | 'cancel'; pnlCents: number; payoutCents: number; balance: number }
export type MultEvent =
  | { type: 'opened'; data: MultOpenedData }
  | { type: 'update'; data: MultUpdateData }
  | { type: 'closed'; data: MultClosedData };

interface GameSocketValue {
  status: ConnStatus;
  online: number;
  fairness: FairnessData | null;
  getTicks: () => Tick[];
  getLastTick: () => Tick | null;
  /** The single in-flight position (optimistic → open → settling), or null. */
  activePosition: ActivePosition | null;
  /** Place a BUY/SELL position (optimistic; reconciled by `position_opened`). */
  openPosition: (input: OpenPositionInput) => void;
  /** Manually cash out the open position (only valid while `sellable`). */
  sell: () => void;

  // ── Phase 2: Deriv-style digits/instrument stream (isolated from the rise/fall path above) ──────
  /** Authoritative per-instrument tick buffer (quote as `rate`), for the digits chart. */
  getInstrumentTicks: () => InstrumentTick[];
  getLastInstrumentTick: () => InstrumentTick | null;
  /** Bumps whenever the subscribed instrument (re)seeds, so the chart re-renders its data. */
  instrumentResetKey: string;
  /** Subscribe the socket to an instrument's authoritative feed (history + live ticks). */
  subscribeInstrument: (instrumentId: string) => void;
  /** Place a DIGIT contract; settlement arrives via `onDigitSettled`. False = not sent (no login / offline). */
  openDigit: (input: OpenDigitInput) => boolean;
  /** Subscribe to authoritative digit settlements. Returns an unsubscribe fn. */
  onDigitSettled: (cb: (s: DigitSettledData) => void) => () => void;
  /** The engine refused a digit open (funds, limits, one-at-a-time…). Returns an unsubscribe fn. */
  onDigitRejected: (cb: (e: { code: string; message: string }) => void) => () => void;
  /** The engine accepted a digit open from THIS socket (its position id). Returns an unsubscribe fn. */
  onDigitOpened: (cb: (e: { positionId: string; instrumentId: string }) => void) => () => void;
  /** Place a MULTIPLIER contract; lifecycle arrives via `onMultiplier`. */
  openMultiplier: (input: OpenMultiplierInput) => void;
  /** Manually close an open multiplier (server may refuse in pool mode). */
  closeMultiplier: (positionId: string) => void;
  /** Subscribe to multiplier lifecycle events (opened/update/closed). Returns an unsubscribe fn. */
  onMultiplier: (cb: (e: MultEvent) => void) => () => void;
}

/** Stable functions (never change identity) — consumers that only trade/read buffers never re-render. */
type GameSocketApi = Omit<GameSocketValue, 'status' | 'online' | 'fairness' | 'activePosition' | 'instrumentResetKey'>;
type GameSocketState = Pick<GameSocketValue, 'status' | 'online' | 'fairness' | 'activePosition'>;
const ApiCtx = createContext<GameSocketApi | null>(null);
const StateCtx = createContext<GameSocketState | null>(null);
const InstKeyCtx = createContext<string>('');

const SYNTH_SPACING_MS = 150;
const SYNTH_SPAN_MS = 60_000;

// Mean-reverting random walk (Ornstein–Uhlenbeck) → an organic, price-chart-like
// curve: broad green hills with occasional red dips. Reverts to a positive mean so
// it stays mostly green (~80%) like the live server feed.
const SYNTH_MU = 0.32;
const SYNTH_THETA = 0.035;
const SYNTH_SIGMA = 0.11;
// Occasional volatility burst so seeded candles vary (bodies + wicks) like a real market tape.
const SYNTH_JUMP_P = 0.06;
const SYNTH_JUMP_K = 3;

/** Approx. standard normal from three uniforms (mean 0, std 1). */
function gaussian(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
}

/** Next signed curve value ∈ [-0.9, 0.9] given the previous one. */
function nextSynth(prev: number): number {
  const burst = Math.random() < SYNTH_JUMP_P ? SYNTH_SIGMA * SYNTH_JUMP_K * gaussian() : 0;
  const v = prev + SYNTH_THETA * (SYNTH_MU - prev) + SYNTH_SIGMA * gaussian() + burst;
  return Math.max(-0.9, Math.min(0.9, v));
}

const synthRate = (value: number) => CURVE_BASE_RATE + CURVE_AMPLITUDE * value;
const rateToValue = (rate: number) => (rate - CURVE_BASE_RATE) / CURVE_AMPLITUDE;

function isTick(v: unknown): v is Tick {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as Tick).t === 'number' && typeof (v as Tick).rate === 'number'
  );
}

function errorTitle(code: string): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Log in to trade';
    case 'AUTH_INVALID':
      return 'Session expired — log in again';
    case 'INSUFFICIENT_FUNDS':
      return 'Insufficient balance';
    case 'SYSTEM_DISABLED':
      return 'Paused';
    default:
      return 'Trade rejected';
  }
}

/**
 * Reformat an engine error for display so amounts are shown in the brand's display currency, never
 * as raw KES cents. e.g. "STAKE_BELOW_MIN: min 25000" -> "Minimum stake is $1.92 (KES 250)".
 */
function friendlyError(
  message: string | undefined,
  reasons: string[] | undefined,
  fmt: (c: number) => string,
): string | undefined {
  const raw = reasons && reasons.length > 0 ? reasons.join(' · ') : message;
  if (!raw) return raw;
  // Engine codes arrive as the message of an ENGINE_ERROR frame: never show a bare code.
  if (/^INSUFFICIENT_FUNDS\b/.test(raw)) return 'Top up or lower the stake.';
  if (/^CONTRACT_EXISTS\b/.test(raw)) return 'One contract at a time on this market.';
  if (/^(INVALID_INSTRUMENT|NO_SEED)\b/.test(raw)) return 'Market unavailable. Pick another.';
  if (/^stake must be integer cents/.test(raw)) return 'Enter a valid stake.';
  let m: RegExpExecArray | null;
  if ((m = /STAKE_BELOW_MIN:\s*min\s*(\d+)/i.exec(raw))) return `Minimum stake is ${fmt(Number(m[1]))}.`;
  if ((m = /STAKE_ABOVE_MAX:\s*max\s*(\d+)/i.exec(raw))) return `Maximum stake is ${fmt(Number(m[1]))}.`;
  // Generic safety: reformat any bare "min <cents>" / "max <cents>" so raw cents never leak through.
  return raw.replace(/\b(min|max)\s+(\d{3,})\b/gi, (_s, w: string, c: string) => `${w} ${fmt(Number(c))}`);
}

/** The user a JWT belongs to (its `sub`), or null. Used only to tell "same user, refreshed token" apart. */
function subOf(token: string | null): string | null {
  if (!token) return null;
  try { return (JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string }).sub ?? null; } catch { return null; }
}

export function GameSocketProvider({ children }: { children: React.ReactNode }) {
  const token = useSession((s) => s.token);
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  // Bind the live socket to the current brand: the multiplexed engine reads `?site=` at connect
  // (before any token) so the public tick stream starts on the right brand; the post-auth JWT
  // `site` claim must then match. Kept in a ref so the mount-scoped connect() closure sees it.
  const brand = useBrand();
  const siteRef = useRef(brand.siteId);
  siteRef.current = brand.siteId;

  const qc = useQueryClient();
  const toast = useToast();
  const { fmt } = useDisplayMoney();
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;

  const ticksRef = useRef<Tick[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const closedRef = useRef(false);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientSeq = useRef(0);
  const realSeenRef = useRef(false);

  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [online, setOnline] = useState(0);
  const [fairness, setFairness] = useState<FairnessData | null>(null);
  const [activePosition, setActivePosition] = useState<ActivePosition | null>(null);
  const activeRef = useRef<ActivePosition | null>(null);

  // Phase 2 — instrument/digit stream state (separate buffer so it never touches the rise/fall path).
  const instTicksRef = useRef<InstrumentTick[]>([]);
  const [instrumentResetKey, setInstrumentResetKey] = useState('');
  const subscribedInstrumentRef = useRef<string | null>(null);
  const digitListenersRef = useRef<Set<(s: DigitSettledData) => void>>(new Set());
  // Digit opens sent and not yet acknowledged: an 'error' frame while one is outstanding is its refusal.
  const digitAwaitingRef = useRef(0);
  const digitRejectRef = useRef<Set<(e: { code: string; message: string }) => void>>(new Set());
  const digitOpenedRef = useRef<Set<(e: { positionId: string; instrumentId: string }) => void>>(new Set());
  const rejectDigit = (code: string, message: string) => {
    digitAwaitingRef.current = Math.max(0, digitAwaitingRef.current - 1);
    digitRejectRef.current.forEach((cb) => { try { cb({ code, message }); } catch { /* non-fatal */ } });
  };
  const multListenersRef = useRef<Set<(e: MultEvent) => void>>(new Set());

  /** Keep ref + state in lockstep so socket handlers can read the current value. */
  const setActive = useCallback(
    (next: ActivePosition | null | ((cur: ActivePosition | null) => ActivePosition | null)) => {
      const resolved = typeof next === 'function' ? next(activeRef.current) : next;
      activeRef.current = resolved;
      setActivePosition(resolved);
    },
    [],
  );

  const getTicks = useCallback(() => ticksRef.current, []);
  const getLastTick = useCallback(
    () => (ticksRef.current.length > 0 ? ticksRef.current[ticksRef.current.length - 1]! : null),
    [],
  );

  const getInstrumentTicks = useCallback(() => instTicksRef.current, []);
  const getLastInstrumentTick = useCallback(
    () => (instTicksRef.current.length > 0 ? instTicksRef.current[instTicksRef.current.length - 1]! : null),
    [],
  );

  const send = useCallback((type: string, data: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, data }));
      return true;
    }
    return false;
  }, []);

  // BUGLOG #88: the engine verifies `auth` asynchronously, so a trade sent in the moments after a
  // (re)connect was refused AUTH_REQUIRED ("Log in to trade" while signed in). Trades wait for the
  // auth answer (the `balance` frame) — at most a few seconds — then go out in order.
  const authedRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  const authQueueRef = useRef<Array<{ type: string; data: unknown; at: number }>>([]);
  const sendTrade = useCallback((type: string, data: unknown): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    if (authedRef.current) { ws.send(JSON.stringify({ type, data })); return true; }
    authQueueRef.current.push({ type, data, at: Date.now() });
    return true;
  }, []);

  // Trades that will never be sent (auth refused / timed out, socket closed): tell whoever waits
  // (BUGLOG #116: only digit opens were told; a classic open stayed "Opening…" for good).
  const dropQueued = (code: string) => {
    const q = authQueueRef.current.splice(0);
    let classic = false;
    for (const m of q) {
      if (m.type === 'open_digit') rejectDigit(code, '');     // the digits screen tells the player
      if (m.type === 'open_position' && activeRef.current && !activeRef.current.positionId) {
        activeRef.current = null; setActivePosition(null); classic = true;
        void qc.invalidateQueries({ queryKey: ['wallet'] });
      }
    }
    if (classic) toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting…' });
  };
  // The auth answer must come within 8 s, or whatever waits behind it is dropped (was: no timer).
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armAuthTimer = () => {
    if (authTimerRef.current) clearTimeout(authTimerRef.current);
    authTimerRef.current = setTimeout(() => { authTimerRef.current = null; if (!authedRef.current) dropQueued('NOT_CONNECTED'); }, 8_000);
  };
  const authAnswered = () => { if (authTimerRef.current) { clearTimeout(authTimerRef.current); authTimerRef.current = null; } };

  const setWalletReal = useCallback(
    (real: number, currency?: string, bonus?: number) => {
      qc.setQueryData<WalletDto>(['wallet'], (old) =>
        old
          ? { ...old, real, ...(typeof bonus === 'number' ? { bonus } : {}) }
          : { real, bonus: bonus ?? 0, currency: currency ?? 'KES' },
      );
    },
    [qc],
  );

  const openPosition = useCallback(
    (input: OpenPositionInput) => {
      if (activeRef.current) return; // single-open rule
      if (!tokenRef.current) {
        toast.push({ tone: 'error', title: 'Log in to trade' });
        return;
      }
      if (!sendTrade('open_position', input)) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting — try again shortly.' });
        return;
      }
      const last = ticksRef.current[ticksRef.current.length - 1] ?? null;
      const now = Date.now();
      setActive({
        positionId: null,
        clientId: `c${++clientSeq.current}`,
        direction: input.direction,
        stakeCents: input.stakeCents,
        durationS: input.durationS,
        phase: 'pending',
        entryRate: last?.rate ?? null,
        expiresAtMs: now + input.durationS * 1000,
        liveMultiplier: 1,
        livePnlCents: 0,
        secondsLeft: input.durationS,
        sellable: false,
      });
      // Optimistic debit; reconciled by the authoritative `balance` push.
      qc.setQueryData<WalletDto>(['wallet'], (old) =>
        old ? { ...old, real: Math.max(0, old.real - input.stakeCents) } : old,
      );
    },
    [qc, send, setActive, toast],
  );

  const sell = useCallback(() => {
    const a = activeRef.current;
    if (!a || !a.positionId || a.phase !== 'open' || !a.sellable) return;
    if (!send('sell', { positionId: a.positionId })) {
      toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting — your position auto-settles at expiry.' });
      return;
    }
    setActive({ ...a, phase: 'settling' });
  }, [send, setActive, toast]);

  const subscribeInstrument = useCallback(
    (instrumentId: string) => {
      if (subscribedInstrumentRef.current === instrumentId && instTicksRef.current.length > 0) return;
      subscribedInstrumentRef.current = instrumentId;
      instTicksRef.current = [];
      setInstrumentResetKey(`${instrumentId}:${Date.now()}`);
      send('subscribe_instrument', { instrumentId }); // no-op if the socket is not open yet; re-sent on hello
    },
    [send],
  );

  const openDigit = useCallback(
    (input: OpenDigitInput): boolean => {
      if (!tokenRef.current) {
        toast.push({ tone: 'error', title: 'Log in to trade' });
        return false;
      }
      if (!sendTrade('open_digit', input)) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting — try again shortly.' });
        return false;
      }
      digitAwaitingRef.current += 1;
      return true;
    },
    [send, toast],
  );

  const onDigitSettled = useCallback((cb: (s: DigitSettledData) => void) => {
    digitListenersRef.current.add(cb);
    return () => { digitListenersRef.current.delete(cb); };
  }, []);

  const onDigitRejected = useCallback((cb: (e: { code: string; message: string }) => void) => {
    digitRejectRef.current.add(cb);
    return () => { digitRejectRef.current.delete(cb); };
  }, []);

  const onDigitOpened = useCallback((cb: (e: { positionId: string; instrumentId: string }) => void) => {
    digitOpenedRef.current.add(cb);
    return () => { digitOpenedRef.current.delete(cb); };
  }, []);

  const openMultiplier = useCallback(
    (input: OpenMultiplierInput) => {
      if (!tokenRef.current) {
        toast.push({ tone: 'error', title: 'Log in to trade' });
        return;
      }
      if (!sendTrade('open_multiplier', input)) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting — try again shortly.' });
      }
    },
    [send, toast],
  );

  const closeMultiplier = useCallback(
    (positionId: string) => {
      if (!send('close_multiplier', { positionId })) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting — try again shortly.' });
      }
    },
    [send, toast],
  );

  const onMultiplier = useCallback((cb: (e: MultEvent) => void) => {
    multListenersRef.current.add(cb);
    return () => { multListenersRef.current.delete(cb); };
  }, []);

  // Pre-fill the tick buffer with a smooth synthetic history so the curve is
  // already full on load (never "fills in" from the right). Keeps emitting until
  // the first real tick arrives, then stands down so live data takes over.
  useEffect(() => {
    if (ticksRef.current.length === 0) {
      const now = Date.now();
      const count = Math.floor(SYNTH_SPAN_MS / SYNTH_SPACING_MS);
      const seed: Tick[] = [];
      let val = SYNTH_MU;
      let prevRate = synthRate(val);
      for (let i = count; i > 0; i--) {
        const t = now - i * SYNTH_SPACING_MS;
        val = nextSynth(val);
        const rate = synthRate(val);
        seed.push({ t, rate, delta: rate - prevRate });
        prevRate = rate;
      }
      ticksRef.current = seed;
    }
    const id = setInterval(() => {
      if (realSeenRef.current) {
        clearInterval(id);
        return;
      }
      const buf = ticksRef.current;
      const t = Date.now();
      const prevRate = buf.length > 0 ? buf[buf.length - 1]!.rate : synthRate(SYNTH_MU);
      const rate = synthRate(nextSynth(rateToValue(prevRate)));
      buf.push({ t, rate, delta: rate - prevRate });
      if (buf.length > MAX_TICKS) buf.splice(0, buf.length - MAX_TICKS);
    }, SYNTH_SPACING_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    closedRef.current = false;

    const clearTimers = () => {
      if (heartbeat.current) clearInterval(heartbeat.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      heartbeat.current = null;
      reconnectTimer.current = null;
    };

    const pushTick = (t: Tick) => {
      const buf = ticksRef.current;
      buf.push(t);
      if (buf.length > MAX_TICKS) buf.splice(0, buf.length - MAX_TICKS);
    };

    const handle = (env_: Envelope) => {
      const data = env_.data;
      switch (env_.type) {
        case 'hello': {
          const d = data as HelloData;
          if (d?.serverSeedHash) setFairness({ serverSeedHash: d.serverSeedHash, tradeDate: d.tradeDate });
          // Re-arm the instrument subscription after a (re)connect so the digits chart keeps streaming.
          if (subscribedInstrumentRef.current) send('subscribe_instrument', { instrumentId: subscribedInstrumentRef.current });
          break;
        }
        case 'tick': {
          if (isTick(data)) {
            realSeenRef.current = true;
            pushTick(data);
          }
          break;
        }
        case 'tick_batch': {
          const items = (data as { ticks?: unknown[] })?.ticks ?? [];
          for (const it of items)
            if (isTick(it)) {
              realSeenRef.current = true;
              pushTick(it);
            }
          break;
        }
        case 'game_config': {
          // The engine pushes this when an operator saves new limits. Invalidating the cached
          // GET /game/config makes stake bounds and round duration update in place, instead of
          // the player being rejected by limits their tab has not seen yet.
          void qc.invalidateQueries({ queryKey: ['gameConfig'] });
          break;
        }
        case 'online': {
          const d = data as OnlineData;
          if (typeof d?.count === 'number') setOnline(d.count);
          break;
        }
        case 'fairness': {
          const d = data as FairnessData;
          if (d?.serverSeedHash) setFairness({ serverSeedHash: d.serverSeedHash, tradeDate: d.tradeDate });
          break;
        }
        case 'balance': {
          const d = data as BalanceData;
          if (typeof d?.real === 'number') setWalletReal(d.real, d.currency, d.bonus);
          if (!authedRef.current) {
            // the auth answer: release trades queued while it was verified
            authedRef.current = true;
            authAnswered();
            const q = authQueueRef.current.splice(0);
            const ws = wsRef.current;
            for (const m of q) ws?.send(JSON.stringify({ type: m.type, data: m.data }));
          }
          break;
        }
        case 'position_opened': {
          const d = data as PositionOpenedData;
          setActive((cur) => ({
            positionId: d.positionId,
            clientId: cur?.clientId ?? `srv${d.positionId}`,
            direction: d.direction,
            stakeCents: d.stakeCents,
            durationS: d.durationS,
            phase: 'open',
            entryRate: d.entryRate,
            expiresAtMs: d.expiresAtMs,
            liveMultiplier: cur?.liveMultiplier ?? 1,
            livePnlCents: cur?.livePnlCents ?? 0,
            secondsLeft: cur?.secondsLeft ?? d.durationS,
            sellable: cur?.sellable ?? false,
          }));
          toast.push({
            tone: 'info',
            title: `Opened · ${d.direction === 'buy' ? 'BUY' : 'SELL'} ${formatKes(d.stakeCents)}`,
            description: `Auto-sell in ${d.durationS}s`,
          });
          break;
        }
        case 'position_update': {
          const d = data as PositionUpdateData;
          setActive((cur) =>
            cur && cur.positionId === d.positionId
              ? {
                  ...cur,
                  phase: cur.phase === 'settling' ? 'settling' : 'open',
                  liveMultiplier: d.liveMultiplier,
                  livePnlCents: d.livePnlCents,
                  secondsLeft: d.secondsLeft,
                  sellable: d.sellable,
                }
              : cur,
          );
          break;
        }
        case 'position_settled': {
          const d = data as PositionSettledData;
          setActive((cur) => (cur && cur.positionId === d.positionId ? null : cur));
          if (typeof d.balance === 'number') setWalletReal(d.balance);
          void qc.invalidateQueries({ queryKey: ['positions'] });
          void qc.invalidateQueries({ queryKey: ['ledger'] });
          // Refresh real + bonus + wagering progress: a settle can spend/convert bonus funds
          // (migration 0094), and only /wallet carries the authoritative bonus + wagering figures.
          void qc.invalidateQueries({ queryKey: ['wallet'] });

          const won = d.result === 'win';
          // stake is recoverable from the authoritative figures: payout − pnl.
          const stakeCents = Math.max(0, Math.round(d.payoutCents - d.pnlCents));
          const mult = d.lockedMultiplier;
          // Prefer the engine's engagement presentation; fall back to a safe local derivation.
          const headline =
            d.presentation?.headline ??
            (won ? (mult >= 2.5 ? 'big_win' : mult < 1.25 ? 'small_win' : 'win') : 'loss');
          useOutcomeFx.getState().show({
            result: d.result,
            headline,
            nearMiss: d.presentation?.nearMiss ?? false,
            lossDisguisedAsWin: d.presentation?.lossDisguisedAsWin ?? (won && mult < 1.25),
            lockedMultiplier: mult,
            payoutCents: d.payoutCents,
            pnlCents: d.pnlCents,
            stakeCents,
            mode: d.mode,
          });
          break;
        }
        // ── Phase 2: instrument stream + digit settlements ────────────────────────────────────
        case 'inst_history': {
          const d = data as { instrumentId: string; ticks: Array<{ t: number; quote: number; digit: number }> };
          if (d.instrumentId !== subscribedInstrumentRef.current) break;
          let prev = d.ticks[0]?.quote ?? 0;
          instTicksRef.current = d.ticks.map((x) => {
            const t: InstrumentTick = { t: x.t, rate: x.quote, delta: x.quote - prev };
            prev = x.quote;
            return t;
          });
          setInstrumentResetKey(`${d.instrumentId}:${d.ticks[d.ticks.length - 1]?.t ?? Date.now()}`);
          break;
        }
        case 'inst_tick': {
          const d = data as { instrumentId: string; t: number; quote: number; digit: number };
          if (d.instrumentId !== subscribedInstrumentRef.current) break;
          const buf = instTicksRef.current;
          const prev = buf.length > 0 ? buf[buf.length - 1]!.rate : d.quote;
          buf.push({ t: d.t, rate: d.quote, delta: d.quote - prev });
          if (buf.length > MAX_TICKS) buf.splice(0, buf.length - MAX_TICKS);
          break;
        }
        case 'digit_opened': {
          digitAwaitingRef.current = Math.max(0, digitAwaitingRef.current - 1);
          const d = data as { positionId: string; instrumentId: string };
          digitOpenedRef.current.forEach((cb) => { try { cb(d); } catch { /* non-fatal */ } });
          break;
        }
        case 'digit_settled': {
          const d = data as DigitSettledData;
          if (typeof d.balance === 'number') setWalletReal(d.balance);
          void qc.invalidateQueries({ queryKey: ['wallet'] });
          void qc.invalidateQueries({ queryKey: ['positions'] });
          void qc.invalidateQueries({ queryKey: ['ledger'] });
          digitListenersRef.current.forEach((cb) => { try { cb(d); } catch { /* listener error is non-fatal */ } });
          break;
        }
        case 'mult_opened': {
          const d = data as MultOpenedData;
          multListenersRef.current.forEach((cb) => { try { cb({ type: 'opened', data: d }); } catch { /* non-fatal */ } });
          break;
        }
        case 'mult_update': {
          const d = data as MultUpdateData;
          multListenersRef.current.forEach((cb) => { try { cb({ type: 'update', data: d }); } catch { /* non-fatal */ } });
          break;
        }
        case 'mult_closed': {
          const d = data as MultClosedData;
          if (typeof d.balance === 'number') setWalletReal(d.balance);
          void qc.invalidateQueries({ queryKey: ['wallet'] });
          void qc.invalidateQueries({ queryKey: ['positions'] });
          void qc.invalidateQueries({ queryKey: ['ledger'] });
          multListenersRef.current.forEach((cb) => { try { cb({ type: 'closed', data: d }); } catch { /* non-fatal */ } });
          break;
        }
        case 'error': {
          const d = data as WsErrorData;
          // Signed in but the socket forgot us (restart / race): authenticate again, quietly.
          if (d.code === 'AUTH_REQUIRED' && tokenRef.current) {
            authedRef.current = false;
            if (send('auth', { token: tokenRef.current })) armAuthTimer();
          }
          if (d.code === 'AUTH_INVALID' || d.code === 'AUTH_SITE_MISMATCH') {
            // auth will not come: nothing queued behind it may wait
            authAnswered();
            dropQueued(d.code);
          } else if (d.code === 'ENGINE_ERROR' && authTimerRef.current && !authedRef.current) {
            // the engine bound us, then failed to read the wallet for its reply: we ARE signed in
            authedRef.current = true;
            authAnswered();
            const ws = wsRef.current;
            for (const m of authQueueRef.current.splice(0)) ws?.send(JSON.stringify({ type: m.type, data: m.data }));
          }
          // BUGLOG #85: a refused digit open used to leave the screen "in play" forever. Only errors an
          // open can produce count (a stray error from another request must not clear a live contract).
          if (digitAwaitingRef.current > 0 && /^(ENGINE_ERROR|AUTH_|SYSTEM_DISABLED|INVALID_INSTRUMENT)/.test(String(d.code ?? '')))
            rejectDigit(String(d.code ?? ''), String(d.message ?? ''));
          const a = activeRef.current;
          if (a && !a.positionId) {
            // optimistic open never acked → roll back and re-sync balance
            setActive(null);
            void qc.invalidateQueries({ queryKey: ['wallet'] });
          } else if (a && a.phase === 'settling') {
            // cash-out failed → restore so the user can retry / let it auto-settle
            setActive({ ...a, phase: 'open' });
          }
          toast.push({
            tone: 'error',
            title: errorTitle(/^INSUFFICIENT_FUNDS/.test(String(d.message ?? '')) ? 'INSUFFICIENT_FUNDS' : d.code),
            description: friendlyError(d.message, d.reasons, fmtRef.current),
          });
          break;
        }
        default:
          break; // pong / unknown frames are ignored
      }
    };

    const connect = () => {
      if (closedRef.current) return;
      setStatus('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrlForSite(env.wsUrl, siteRef.current));
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        authedRef.current = false;
        setStatus('open');
        if (tokenRef.current) { ws.send(JSON.stringify({ type: 'auth', data: { token: tokenRef.current } })); armAuthTimer(); }
        // Heartbeat + dead-socket check (BUGLOG #92): on a network switch a socket can stay "OPEN" for
        // minutes while nothing arrives. A ping every 6 s guarantees a frame (pong) even on a brand with a
        // slow tick rate, so 12 s of silence = a dead socket = reconnect.
        lastFrameAtRef.current = Date.now();
        let beats = 0;
        heartbeat.current = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return;
          if (Date.now() - lastFrameAtRef.current > 12_000) { try { ws.close(); } catch { /* ignore */ } return; }
          if (++beats % 2 === 0) ws.send(JSON.stringify({ type: 'ping', data: {} }));
        }, 3_000);
      };

      ws.onmessage = (ev) => {
        lastFrameAtRef.current = Date.now();
        let parsed: Envelope;
        try {
          parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as Envelope;
        } catch {
          return;
        }
        if (parsed && typeof parsed.type === 'string') handle(parsed);
      };

      ws.onclose = () => {
        if (heartbeat.current) clearInterval(heartbeat.current);
        heartbeat.current = null;
        authedRef.current = false;
        // acks for opens in flight on this socket will never come (BUGLOG #85/#92); queued ones are
        // dropped just below (each told once)
        const queuedDigits = authQueueRef.current.filter((m) => m.type === 'open_digit').length;
        const inflight = Math.max(0, digitAwaitingRef.current - queuedDigits);
        for (let i = 0; i < inflight; i++) rejectDigit('NOT_CONNECTED', '');
        // queued trades never left: nobody may wait for them
        authAnswered();
        dropQueued('NOT_CONNECTED');
        digitAwaitingRef.current = 0;
        if (!closedRef.current) {
          setStatus('closed');
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    const scheduleReconnect = () => {
      if (closedRef.current) return;
      const n = attemptRef.current++;
      const delay = Math.min(1000 * 2 ** n, 10_000) + Math.random() * 500;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closedRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) ws.close();
      wsRef.current = null;
    };
    // socket lifecycle is mount-scoped; stable callbacks/refs are intentionally omitted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Token changes. Sign-in on an open socket: authenticate it (trades wait for the answer). Sign-out
  // or a different account (BUGLOG #93): the socket was bound to the previous user and kept receiving
  // their balance and settlements — reconnect it, and drop that user's cached wallet/history/session.
  const prevTokenRef = useRef<string | null>(token);
  useEffect(() => {
    const prev = prevTokenRef.current;
    prevTokenRef.current = token;
    if (prev === token) return;
    const ws = wsRef.current;
    if (prev && prev !== token && subOf(prev) !== subOf(token)) {
      authedRef.current = false;
      // caches and session stores are dropped app-wide by SessionCacheGuard
      if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) { ws.close(); return; } // onclose reconnects; onopen authenticates
    }
    if (token && ws && ws.readyState === ws.OPEN) {
      authedRef.current = false;
      ws.send(JSON.stringify({ type: 'auth', data: { token } }));
      armAuthTimer();
    }
  }, [token]);

  // Perf (BUGLOG #92): the value used to be a new object every render, and `online` changes on every
  // connect/disconnect across the brand — re-rendering the whole trade screen and chart each time.
  const apiValue = useMemo<GameSocketApi>(() => ({
    getTicks, getLastTick, openPosition, sell, getInstrumentTicks, getLastInstrumentTick, subscribeInstrument,
    openDigit, onDigitSettled, onDigitRejected, onDigitOpened, openMultiplier, closeMultiplier, onMultiplier,
  }), [getTicks, getLastTick, openPosition, sell, getInstrumentTicks, getLastInstrumentTick, subscribeInstrument,
    openDigit, onDigitSettled, onDigitRejected, onDigitOpened, openMultiplier, closeMultiplier, onMultiplier]);
  const stateValue = useMemo<GameSocketState>(() => ({ status, online, fairness, activePosition }), [status, online, fairness, activePosition]);

  return (
    <ApiCtx.Provider value={apiValue}>
      <StateCtx.Provider value={stateValue}>
        <InstKeyCtx.Provider value={instrumentResetKey}>
          {children}
        </InstKeyCtx.Provider>
      </StateCtx.Provider>
    </ApiCtx.Provider>
  );
}

export function useGameSocket(): GameSocketValue {
  const api = useContext(ApiCtx);
  const state = useContext(StateCtx);
  const instrumentResetKey = useContext(InstKeyCtx);
  if (!api || !state) throw new Error('useGameSocket must be used within <GameSocketProvider>');
  return { ...api, ...state, instrumentResetKey };
}

/** Only the stable trading/buffer functions: no re-render on status/online/position changes. */
export function useGameSocketApi(): GameSocketApi {
  const api = useContext(ApiCtx);
  if (!api) throw new Error('useGameSocketApi must be used within <GameSocketProvider>');
  return api;
}

/** Bumps when the subscribed instrument (re)seeds. */
export function useInstrumentResetKey(): string { return useContext(InstKeyCtx); }
