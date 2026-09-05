'use client';

import {
  createContext,
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

const MAX_TICKS = 3000;

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
}

const Ctx = createContext<GameSocketValue | null>(null);

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
    default:
      return 'Trade rejected';
  }
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

  const send = useCallback((type: string, data: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, data }));
      return true;
    }
    return false;
  }, []);

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
      if (!send('open_position', input)) {
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
        case 'error': {
          const d = data as WsErrorData;
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
            title: errorTitle(d.code),
            description: d.reasons && d.reasons.length > 0 ? d.reasons.join(' · ') : d.message,
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
        setStatus('open');
        if (tokenRef.current) ws.send(JSON.stringify({ type: 'auth', data: { token: tokenRef.current } }));
        heartbeat.current = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping', data: {} }));
        }, 15_000);
      };

      ws.onmessage = (ev) => {
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

  // Authenticate the live socket the moment a token becomes available post-connect.
  useEffect(() => {
    const ws = wsRef.current;
    if (token && ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'auth', data: { token } }));
    }
  }, [token]);

  return (
    <Ctx.Provider
      value={{
        status,
        online,
        fairness,
        getTicks,
        getLastTick,
        activePosition,
        openPosition,
        sell,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useGameSocket(): GameSocketValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useGameSocket must be used within <GameSocketProvider>');
  return v;
}
