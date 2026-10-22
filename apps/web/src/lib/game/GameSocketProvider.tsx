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
import type { Direction } from '@invest254/shared';
import { formatKes } from '@invest254/shared/money';
import { CURVE_AMPLITUDE, CURVE_BASE_RATE } from '@invest254/shared/config';
import { env } from '@/lib/env';
import { useBrand } from '@/lib/brand/BrandProvider';
import { curveProfileForChartStyle, chartStyleOf, tradingViewTypeOf, type Candle } from '@invest254/shared/chart';
import { valueOfRate, type Timeframe, type MarketSymbol } from '@invest254/shared/candles';
import { wsUrlForSite } from '@/lib/brand/brand';
import { useSession } from '@/lib/auth/session';
import { useToast } from '@/lib/toast/ToastProvider';
import { useDisplayMoney } from '@/lib/money';
import { useOutcomeFx } from '@/lib/game/outcomeFx';
import { logJournal } from '@/lib/game/journal';
import { play } from '@/lib/sound/sound';
import {
  errorTitle, friendlyError, type LocalRefusal,
} from '@/lib/game/orderResult';
import { orderWindowWaiting } from '@/lib/game/orderWindow';
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
  PlacePendingInput,
  PendingOrderDto,
  PositionOpenedData,
  PositionSettledData,
  PositionUpdateData,
  WsErrorData,
} from '@/lib/game/betting';
import { ticketLabel } from '@/lib/game/betting';
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
  /**
   * EVERY open position, oldest first. MetaTrader's Trade tab is a grid of these, not one card.
   * `activePosition` is the newest of them, for the surfaces that are genuinely about one.
   */
  positions: readonly ActivePosition[];
  /**
   * Place a BUY/SELL position (optimistic; reconciled by `position_opened`).
   *
   * Returns the reason it was NOT sent, or null when it went. It used to return void and refuse
   * silently, which hid the single-open rule completely: a contract still settling counts as open
   * while the Trade screen already says "No open positions", so a tap did nothing at all for a
   * reason nothing on screen stated. MetaTrader puts a rejection in the order window, and it
   * cannot do that without being told.
   */
  openPosition: (input: OpenPositionInput) => LocalRefusal | null;
  /**
   * Move or clear the protective levels on the open position (MetaTrader's Modify position).
   *
   * Returns false when there is nothing open or the socket is down. The engine's reply is the
   * truth; this only asks.
   */
  setLevels: (slPrice: number | null, tpPrice: number | null, positionId?: string) => boolean;
  /**
   * MetaTrader's pending orders: arm one at a price, cancel one, and read what is waiting.
   *
   * `placePending` only ASKS. The engine validates the level against its own price, which is the
   * one that matters: the browser's is a tick or two old, and an order placed against a stale
   * price is one that fills the instant it is made. Returns false when the socket is down.
   */
  placePending: (input: PlacePendingInput) => boolean;
  cancelPending: (orderId: string) => boolean;
  /**
   * The last trade error the engine sent, for the order window to show as MetaTrader's rejection.
   *
   * Carries the same title and detail the toast uses, from `lib/game/orderResult`, so the two
   * cannot drift into saying different things about one refusal.
   */
  lastTradeError: { code: string; title: string; detail: string | undefined; at: number } | null;
  /**
   * Manually close a position (only valid while `sellable`).
   *
   * Names the position explicitly, because several can be open: omitted it means the newest, which
   * is what the surfaces that only ever speak about one have always meant.
   */
  sell: (positionId?: string) => void;
  /**
   * Whether `sell` can succeed on this brand at all. The engine refuses every manual close while
   * the brand runs in pool mode, so a Close control, and anything built on it (take profit), is
   * only honest where this is true. False until the engine has said otherwise.
   */
  earlyCloseEnabled: boolean;
  /**
   * The brand's spread per side in curve-value units, or null where the brand quotes one price.
   *
   * What makes MetaTrader's Bid and Ask real here rather than drawn: the engine already charges
   * this on every continuous position (settle.ts, "`cost` is economically the SPREAD"), so a buy
   * priced at the ask and a sell at the bid is the truth about the trade, stated.
   */
  spread: { buy: number; sell: number } | null;
  /**
   * The orders armed at a price, waiting for the market, as the ENGINE holds them.
   *
   * Never guessed at from what this tab sent: the engine is the side that fills them, and it is
   * also the side a second device's order arrives at. The list is asked for on connect and
   * refreshed whenever one is placed, cancelled or filled.
   */
  pendingOrders: readonly PendingOrderDto[];

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

  // ── Candle history (MT5 chart). Display-only: these bars settle nothing. ───────────────────────
  /**
   * Closed OHLC bars at an MT5 period, newest last, plus the anchor that places live ticks on the
   * same price axis. Pass `to` (a bar time in epoch seconds) to page further back.
   *
   * Rejects rather than resolving empty, so the chart can tell "no history here" from "ask again".
   */
  requestCandles: (tf: Timeframe, count: number, to?: number, symbol?: string) => Promise<CandlesReply>;
  /**
   * The brand's tradable list, for Market Watch and the Symbols dialog.
   *
   * Carries no prices. What each symbol IS is static; what it costs comes off the quote stream, and
   * a price embedded here would be one nothing could age.
   */
  requestSymbols: () => Promise<SymbolsReply>;
  /**
   * The symbol this brand SETTLES, as the engine itself names it, or null before it has said.
   *
   * The one authority for the question. Everything that needs to know whether the chart is on
   * another instrument asks `chartOverride`/`useChartedSymbol` (lib/game/chartSymbol), which asks
   * this: three separate derivations of "the brand's own symbol" used to disagree, and the order
   * ticket printed a refusal naming the very symbol it was already on.
   */
  getSettledSymbol: () => string | null;
  /**
   * Replace the set of symbols this client wants live quotes for.
   *
   * A SET, not an addition, because that is what a Market Watch list is: the client owns it and
   * re-sends it when the trader changes it. Re-armed automatically after a reconnect.
   */
  subscribeSymbols: (symbols: readonly string[]) => void;
  /** A watched symbol's live quote, or null before its first one lands. */
  getSymbolQuote: (symbol: string) => SymbolQuote | null;
  /** The symbol's recent quotes, newest last, which is what the Ticks tab draws. */
  getSymbolTicks: (symbol: string) => readonly { t: number; price: number }[];
  /**
   * Instrument and day anchor from the most recent candle reply, or null before one has landed.
   *
   * It lets anything outside the chart — the price strip, an order ticket, a position's P/L — quote
   * the same symbol at the same price as the chart, instead of each deriving its own.
   */
  getMarket: () => { instrument: MarketSymbol; anchor: CandlesReply['anchor'] } | null;
  /** Market newswire for the News tab. Public market copy; rejects on failure. */
  requestNews: (limit?: number) => Promise<NewsReply>;
  /**
   * The day anchors needed to place rates from EARLIER days on the price axis.
   *
   * `getMarket()` carries today's anchor only, and the axis is re-anchored every UTC midnight, so a
   * rate recorded on an older day cannot be priced from it. Ask the engine for that day's own.
   */
  requestAnchors: (days: readonly string[]) => Promise<AnchorsReply>;
}

export interface NewsItemDto {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAtMs: number;
  summary: string;
}
export interface NewsReply { items: NewsItemDto[]; fetchedAtMs: number }

/** One UTC day's price anchor: price = base + instrument.scale * (value(t) - openValue). */
export interface DayAnchor { dateKey: string; base: number; openValue: number }
export interface AnchorsReply { instrument: MarketSymbol; days: DayAnchor[] }

/** One row of the brand's tradable list. `group` is MetaTrader's tree path, e.g. `Forex\\Majors`. */
export interface SymbolRow { symbol: string; description: string; group: string; digits: number }
export interface SymbolsReply { defaultSymbol: string; symbols: SymbolRow[] }

/**
 * A watched symbol's live state: enough to print its price and colour it the way MetaTrader does.
 *
 * `price` is kept alongside `rate` because every consumer would otherwise redo the same arithmetic
 * against the same anchor, and one of them would eventually use the wrong symbol's anchor.
 */
/** Stable empty result, so a symbol with no ticks yet does not hand out a fresh array a frame. */
const EMPTY_TICKS: ReadonlyArray<{ t: number; price: number }> = [];

/** MetaTrader's own depth: "The platform stores up to 2000 last ticks for each symbol." */
const SYMBOL_TICK_CAP = 2_000;

export interface SymbolQuote {
  symbol: string;
  instrument: MarketSymbol;
  anchor: { tradeDate: string; base: number; openValue: number };
  rate: number;
  price: number;
  /** Direction of the last price CHANGE, and when it changed. See lib/game/quoteTone. */
  up: boolean | null;
  changedAt: number | null;
  t: number;
  /**
   * The day's high and low SO FAR, as prices, which MetaTrader's phone row prints as `H:` and `L:`.
   *
   * They arrive on the quote because the engine is the only side that can know them: it holds the
   * day, and a client deriving them would have to fetch a day of bars per watched symbol. Null
   * until the first quote carrying them lands, and on an engine that predates them, which is why
   * the row renders without them rather than printing a dash.
   */
  dayHigh: number | null;
  dayLow: number | null;
}

export interface CandlesReply {
  tf: Timeframe;
  instrument: MarketSymbol;
  bars: Candle[];
  /** price = base + instrument.scale * (valueOfRate(tick.rate) - openValue) */
  anchor: { tradeDate: string; base: number; openValue: number };
}

/** Stable functions (never change identity) — consumers that only trade/read buffers never re-render. */
type GameSocketApi = Omit<GameSocketValue, 'status' | 'online' | 'fairness' | 'activePosition' | 'positions' | 'earlyCloseEnabled' | 'spread' | 'pendingOrders' | 'lastTradeError' | 'instrumentResetKey'>;
type GameSocketState = Pick<GameSocketValue, 'status' | 'online' | 'fairness' | 'activePosition' | 'positions' | 'earlyCloseEnabled' | 'spread' | 'pendingOrders' | 'lastTradeError'>;
const ApiCtx = createContext<GameSocketApi | null>(null);
const StateCtx = createContext<GameSocketState | null>(null);
const InstKeyCtx = createContext<string>('');

const SYNTH_SPACING_MS = 150;
const SYNTH_SPAN_MS = 60_000;

// CLIENT-ONLY placeholder tape, shown until the first real engine tick arrives (or while offline).
// It mirrors the engine's price curve (packages/shared/curve.ts): a dense, non-harmonic spectrum of
// pink-noise sinusoids ⇒ fractional-Brownian-motion texture (trends, pullbacks, varied candles) that
// reads like a market, NOT a repeating wave. It is NOT seeded/deterministic and never decides any
// outcome — purely cosmetic, so live data overwrites it the moment it arrives.
const SYNTH_DRIFT = 0.30;  // green bias — mirrors DEFAULT_CONFIG.driftBias
const SYNTH_VOL = 1.0;     // amplitude scaler — mirrors DEFAULT_CONFIG.volatility

const synthRate = (value: number) => CURVE_BASE_RATE + CURVE_AMPLITUDE * value;

// The two shapes the engine curve uses (packages/shared/curve.ts), mirrored here so the placeholder
// matches the brand it is standing in for: `wave` for line brands (irregular rise/fall waves),
// `market` for the trending candlestick/bars/area brands.
const SYNTH_PROFILES = {
  market: { K: 16, baseFreq: 0.006, ratio: 1.42, ampExp: 0.85, fj: 0.38, fj0: 0.82, aj: 0.4, aj0: 0.8, driftScale: 1 },
  wave: { K: 14, baseFreq: 0.022, ratio: 1.4, ampExp: 0.5, fj: 0.65, fj0: 0.7, aj: 0.75, aj0: 0.65, driftScale: 0.18 },
} as const;

/** Build a closed-form fBm-like curve value(t) (seconds) in (-1,1), matching the engine's shape. */
function makeSynthCurve(profile: 'market' | 'wave'): (t: number) => number {
  const p = SYNTH_PROFILES[profile];
  const comps: { freq: number; amp: number; phase: number }[] = [];
  let ampSum = 0;
  for (let k = 0; k < p.K; k++) {
    const freq = p.baseFreq * p.ratio ** k * (p.fj0 + Math.random() * p.fj); // jitter off the ladder
    const amp = (1 / freq ** p.ampExp) * (p.aj0 + Math.random() * p.aj);      // pink-ish spectrum
    ampSum += amp;
    comps.push({ freq, amp, phase: Math.random() * 2 * Math.PI });
  }
  return (t: number) => {
    let s = 0;
    for (const c of comps) s += c.amp * Math.sin(2 * Math.PI * c.freq * t + c.phase);
    return Math.tanh((s / ampSum) * SYNTH_VOL + SYNTH_DRIFT * p.driftScale);
  };
}

function isTick(v: unknown): v is Tick {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as Tick).t === 'number' && typeof (v as Tick).rate === 'number'
  );
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
  const synthCurveRef = useRef<((t: number) => number) | null>(null);
  const synthOriginRef = useRef(0);
  // Placeholder tape shape for this brand: `wave` for line brands, `market` for candlestick/bars/area.
  const synthProfileRef = useRef<'market' | 'wave'>(curveProfileForChartStyle(chartStyleOf(brand.chartStyle)));
  synthProfileRef.current = curveProfileForChartStyle(chartStyleOf(brand.chartStyle));
  /**
   * Whether this brand draws its own quotes from the engine, read inside the socket handler.
   *
   * A ref rather than a value, because the handler is installed once and closes over what it can
   * see; a brand read at install time would be stale after a brand switch.
   *
   * DELIBERATELY still the CHART test, not `isBrokerTerminalBrand`. Everywhere else that asked
   * "is this a terminal?" was moved onto `isBrokerTerminalBrand`, so a candlestick or digits brand
   * stops getting MetaTrader's chrome and screens. This one is a different question and must not
   * follow: it gates the SYNTHETIC CURVE backdrop below, which exists only for the classic shell.
   * A candlestick brand renders real engine candles, so handing it a synthesized curve would put
   * made-up numbers on a live trading screen — exactly what the note on that effect warns about
   * ("a trader could have read a made-up number and pressed Buy against it"). Chart-driven shells
   * show nothing until the engine speaks, which is the truth.
   */
  const terminalRef = useRef(tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null);
  terminalRef.current = tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null;

  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [online, setOnline] = useState(0);
  const [fairness, setFairness] = useState<FairnessData | null>(null);
  // Set from the engine's hello. False until then: the close affordances stay away rather than
  // appearing and then failing.
  const [earlyCloseEnabled, setEarlyCloseEnabled] = useState(false);
  /**
   * The brand's spread per side, in curve-value units, straight off the engine's hello.
   *
   * Null means this brand quotes ONE price, which is every line brand and every engine written
   * before the field. It is never guessed: a terminal that invents a spread is quoting a price the
   * server never sent, which is the thing this client just stopped doing.
   */
  const [spread, setSpread] = useState<{ buy: number; sell: number } | null>(null);
  const [pendingOrders, setPendingOrders] = useState<readonly PendingOrderDto[]>([]);
  /**
   * EVERY position this account currently has running, oldest first.
   *
   * MetaTrader holds many at once: its Trade tab is "open positions above the account summary strip
   * ... in a single shared column grid" (docs/mt5/09-toolbox.md 250), its Exposure tab adds them up,
   * and Margin, Free Margin and Margin Level only mean anything across several. The engine, the
   * socket protocol and the database have always agreed: `sell` and `set_levels` carry a
   * `positionId`, `open_positions` is an array, and every row has its own ticket.
   *
   * Only this file disagreed. It kept ONE position, refused a second order with `POSITION_OPEN`,
   * and the ticket replaced itself with a position card, so there was no control left to place
   * another trade with. That was never the engine's rule; it was this state shape.
   */
  const [positions, setPositionsState] = useState<ActivePosition[]>([]);
  const positionsRef = useRef<ActivePosition[]>([]);
  /**
   * The last trade rejection, for the order window to show.
   *
   * Stamped with `at` so a window can tell a fresh refusal from the one it already showed: two
   * identical refusals in a row are two events, and the second has to re-render.
   */
  const [lastTradeError, setLastTradeError] =
    useState<{ code: string; title: string; detail: string | undefined; at: number } | null>(null);

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
  const setPositions = useCallback(
    (next: ActivePosition[] | ((cur: readonly ActivePosition[]) => ActivePosition[])) => {
      const resolved = typeof next === 'function' ? next(positionsRef.current) : next;
      positionsRef.current = resolved;
      setPositionsState(resolved);
    },
    [],
  );

  /**
   * Change one position, identified however the caller knows it.
   *
   * A position has two identities over its life: the `clientId` this tab made when the order was
   * sent, and the `positionId` the engine answers with. A frame arriving before the ack can only be
   * matched on the first, and everything after it on the second, so both are accepted.
   */
  const patchPosition = useCallback(
    (key: { positionId?: string | null; clientId?: string },
     fn: (p: ActivePosition) => ActivePosition | null) => {
      setPositions((cur) => {
        const out: ActivePosition[] = [];
        for (const p of cur) {
          const hit = (key.positionId != null && p.positionId === key.positionId)
            || (key.clientId !== undefined && p.clientId === key.clientId);
          if (!hit) { out.push(p); continue; }
          const next = fn(p);
          if (next) out.push(next);
        }
        return out;
      });
    },
    [setPositions],
  );

  /**
   * The position the single-position surfaces still speak for: the NEWEST one.
   *
   * MetaTrader's own surfaces are plural (the Trade grid, Exposure, the margin figures) and those
   * read `positions`. A few genuinely singular ones remain, among them the chart's level overlay and
   * the phone's one-position card, and for those "the position the trader just opened" is the one
   * they mean. Derived rather than stored, so it can never disagree with the list.
   */
  const activePosition = useMemo<ActivePosition | null>(
    () => positions[positions.length - 1] ?? null,
    [positions],
  );

  /**
   * The order-acknowledgement watchdog.
   *
   * `open_position` is the one request on this socket that moves money, and it was the only one with
   * no bound on the wait: candles and anchors time out at 20s, symbols and news have their own
   * waiters, auth at 8s, and an order had nothing. A lost `position_opened` therefore left the card
   * reading "Opening…" with the stake optimistically debited, for the life of the page. The engine
   * cannot be the slow part: measured against it, an order is acknowledged in 0.4ms at the median,
   * 1.9ms at p95 and 4.1ms at the worst of 25 (scratchpad/acklat2.mjs), so everything past that is
   * network. 8s matches the auth timeout already in this file, which is the same judgement about the
   * same socket.
   *
   * On firing it does NOT roll back. Rolling back a position the engine really opened would leave a
   * trader unable to see or close it, which is worse than the freeze; keeping one that was never
   * opened shows money committed to nothing. So it asks: `sync_positions` is answered with the
   * authoritative list, and `open_positions` below resolves the pending order against it either way.
   */
  const OPEN_ACK_TIMEOUT_MS = 8_000;
  /**
   * One watchdog PER OUTSTANDING ORDER, keyed by the `clientId` it was sent with.
   *
   * It used to be a single timer, which was right while only one order could exist. With several in
   * flight a shared timer is worse than none: sending a second order would clear the first order's
   * guard, so the very case the watchdog exists for, a lost ack, would go unwatched on every order
   * but the last.
   */
  const openAckTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** True between a watchdog firing and the `open_positions` that answers it. */
  const awaitingSync = useRef(false);
  /** Disarm one order's watchdog: its answer arrived. */
  const clearOpenAck = useCallback((clientId?: string) => {
    if (clientId === undefined) {
      for (const t of openAckTimers.current.values()) clearTimeout(t);
      openAckTimers.current.clear();
    } else {
      const t = openAckTimers.current.get(clientId);
      if (t) { clearTimeout(t); openAckTimers.current.delete(clientId); }
    }
    if (openAckTimers.current.size === 0) awaitingSync.current = false;
  }, []);

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

  /**
   * Candle requests waiting for a reply, by request id.
   *
   * The chart pages backwards while the live edge keeps updating, so several can be in flight at
   * once; the engine echoes the id so each reply — including a failure — matches its own request.
   */
  const candleWaitersRef = useRef(new Map<string, { resolve: (r: CandlesReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const candleSeqRef = useRef(0);
  const marketRef = useRef<{ instrument: MarketSymbol; anchor: CandlesReply['anchor'] } | null>(null);
  const getMarket = useCallback(() => marketRef.current, []);
  /**
   * The symbol this brand SETTLES, which is a different question from the one the chart is drawing.
   *
   * The engine answers it outright: the `symbols` reply carries `defaultSymbol`, documented there as
   * "the symbol the chart draws when a client asks for none, so a client need not know which of the
   * list that is". Holding it here makes it one answer for the whole app. It used to be derived in
   * three places from two different sources, and the three could disagree — which is how the order
   * ticket came to print `Trade disabled for XAUUSD` while the chart was drawing XAUUSD.
   *
   * Null until the first `symbols` reply or the first default-symbol `candles` reply lands. Null
   * means "not known yet", which is never the same as "the chart is on something else".
   */
  const settledSymbolRef = useRef<string | null>(null);
  const getSettledSymbol = useCallback(() => settledSymbolRef.current, []);
  /** The candle requests that asked for the brand's own symbol, so only their replies may anchor it. */
  const defaultCandleReqsRef = useRef(new Set<string>());
  /**
   * Candle frames raised before the socket was open, flushed once it is.
   *
   * The chart mounts with the page and asks for history immediately, which is almost always before
   * the WebSocket has finished connecting. Failing there left the chart stuck on "History
   * unavailable" for the whole session; holding the frame costs nothing and the per-request deadline
   * still applies.
   */
  const candleOutboxRef = useRef<Array<{ reqId: string; tf: Timeframe; count: number; to?: number; symbol?: string }>>([]);

  const settleCandleWaiter = useCallback((reqId: string, outcome: { ok: CandlesReply } | { err: Error }): void => {
    const w = candleWaitersRef.current.get(reqId);
    if (!w) return;
    candleWaitersRef.current.delete(reqId);
    clearTimeout(w.timer);
    if ('ok' in outcome) w.resolve(outcome.ok); else w.reject(outcome.err);
  }, []);

  /** Reject everything still waiting — the socket went away, so no reply is ever coming. */
  const dropCandleWaiters = useCallback((reason: string): void => {
    for (const [id] of candleWaitersRef.current) settleCandleWaiter(id, { err: new Error(reason) });
  }, [settleCandleWaiter]);

  /**
   * Replies already in hand, and requests already on the wire, keyed by what was asked for.
   *
   * The engine builds history from a seeded curve rather than reading it out of a table, so an
   * answer costs it real work: measured here, a cold request for daily bars took four and a half
   * seconds and blocked the tick loop for every trader in the process while it ran. The same
   * answer being asked for twice was therefore not a wasted round trip but a wasted four seconds.
   *
   * Two things were asking twice. A trader clicking through periods and back (M1, M5, M1) refetched
   * each one from scratch, and the chart itself fired a second identical request on its first
   * connect. Both are now free.
   *
   * CLOSED bars only. A request with no `to` ends at the last closed bar, which never changes once
   * it has closed, so a cached reply cannot go stale — except across a UTC midnight, when the
   * engine reseeds the day and the chart force-refetches anyway; `clearCandleCache` is called from
   * that same path. The live edge is drawn from the tick stream, never from these.
   */
  const candleCacheRef = useRef(new Map<string, { reply: CandlesReply; atMs: number }>());
  /** The engine's current trade date, so a reseed at UTC midnight can drop the cache. */
  const lastTradeDateRef = useRef<string | null>(null);
  const candleInflightRef = useRef(new Map<string, Promise<CandlesReply>>());
  const CANDLE_CACHE_MAX = 40;
  const clearCandleCache = useCallback(() => {
    candleCacheRef.current.clear();
    candleInflightRef.current.clear();
  }, []);

  const requestCandles = useCallback((tf: Timeframe, count: number, to?: number, symbol?: string): Promise<CandlesReply> => {
    const key = `${symbol ?? ''}|${tf}|${count}|${to ?? ''}`;
    const hit = candleCacheRef.current.get(key);
    if (hit) return Promise.resolve(hit.reply);
    const flying = candleInflightRef.current.get(key);
    if (flying) return flying;
    const reqId = `c${++candleSeqRef.current}`;
    const promise = new Promise<CandlesReply>((resolve, reject) => {
      // No symbol means the brand's default, which is what every caller written before multi-symbol
      // asks for. Naming one that the brand does not offer is refused by the engine rather than
      // answered with the default's bars under the requested name.
      const frame = { reqId, tf, count, ...(to === undefined ? {} : { to }), ...(symbol === undefined ? {} : { symbol }) };
      // Remembered so the reply can be told apart from another symbol's. Only a reply to a request
      // that named NO symbol may re-anchor the shared market axis: the axis is what stamps a
      // position's entry price and what every open position's P/L is measured against, so letting
      // a chart lookup of EURUSD set it would re-price trades that were never on EURUSD.
      if (symbol === undefined || symbol === settledSymbolRef.current) defaultCandleReqsRef.current.add(reqId);
      if (!send('candles', frame)) candleOutboxRef.current.push(frame);
      // Without a deadline a dropped reply would leave the chart spinning for ever.
      const timer = setTimeout(() => settleCandleWaiter(reqId, { err: new Error('CANDLES_TIMEOUT') }), 20_000);
      candleWaitersRef.current.set(reqId, { resolve, reject, timer });
    });
    candleInflightRef.current.set(key, promise);
    return promise.then(
      (reply) => {
        candleInflightRef.current.delete(key);
        // Oldest out first, so a session that pages a long way back cannot grow this without bound.
        if (candleCacheRef.current.size >= CANDLE_CACHE_MAX) {
          const oldest = candleCacheRef.current.keys().next().value;
          if (oldest !== undefined) candleCacheRef.current.delete(oldest);
        }
        candleCacheRef.current.set(key, { reply, atMs: Date.now() });
        return reply;
      },
      (err: Error) => {
        // A failure is never cached: the next attempt must really ask.
        candleInflightRef.current.delete(key);
        throw err;
      },
    );
  }, [send, settleCandleWaiter]);

  // ── Day anchors ────────────────────────────────────────────────────────────────────────────────
  // Request-id matched like the candles, not queued like the news: two tabs of the Toolbox can be
  // asking about different sets of days at once, and a reply must reach the caller that wanted it.
  const anchorSeqRef = useRef(0);
  const anchorWaitersRef = useRef<Map<string, { resolve: (r: AnchorsReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const anchorOutboxRef = useRef<Array<{ reqId: string; days: string[] }>>([]);

  const settleAnchorWaiter = useCallback((reqId: string, outcome: { ok: AnchorsReply } | { err: Error }): void => {
    const w = anchorWaitersRef.current.get(reqId);
    if (!w) return;
    anchorWaitersRef.current.delete(reqId);
    clearTimeout(w.timer);
    if ('ok' in outcome) w.resolve(outcome.ok); else w.reject(outcome.err);
  }, []);

  const requestAnchors = useCallback((days: readonly string[]): Promise<AnchorsReply> => {
    const reqId = `a${++anchorSeqRef.current}`;
    return new Promise<AnchorsReply>((resolve, reject) => {
      const frame = { reqId, days: [...days] };
      if (!send('anchors', frame)) anchorOutboxRef.current.push(frame);
      const timer = setTimeout(() => settleAnchorWaiter(reqId, { err: new Error('ANCHORS_TIMEOUT') }), 20_000);
      anchorWaitersRef.current.set(reqId, { resolve, reject, timer });
    });
  }, [send, settleAnchorWaiter]);

  // ── The brand's symbol list, and live quotes for the ones this client watches ──────────────────
  /**
   * Queued rather than request-id matched, like the newswire and unlike the candles: there is one
   * list per brand and one shape of answer, so the next `symbols` frame belongs to everyone waiting.
   */
  const symbolsWaitersRef = useRef<Array<{ resolve: (r: SymbolsReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>([]);
  const symbolsOutboxRef = useRef(false);
  const requestSymbols = useCallback((): Promise<SymbolsReply> => new Promise<SymbolsReply>((resolve, reject) => {
    // Asked for before the socket is ready (Market Watch mounts with the page), the request is held
    // and flushed on open: failing outright would leave the list permanently empty.
    if (!send('symbols', {})) symbolsOutboxRef.current = true;
    const timer = setTimeout(() => {
      const i = symbolsWaitersRef.current.findIndex((w) => w.timer === timer);
      if (i >= 0) symbolsWaitersRef.current.splice(i, 1)[0]!.reject(new Error('SYMBOLS_TIMEOUT'));
    }, 20_000);
    symbolsWaitersRef.current.push({ resolve, reject, timer });
  }), [send]);

  /** The symbols asked for, kept so the subscription can be re-armed after a reconnect. */
  const watchedRef = useRef<readonly string[]>([]);
  const quotesRef = useRef(new Map<string, SymbolQuote>());
  /**
   * The recent quotes of each watched symbol, which is what Market Watch's Ticks tab draws.
   *
   * MetaTrader "stores up to 2000 last ticks for each symbol" and clears a symbol's chart when it
   * is removed from Market Watch, so that is exactly what this is: a bounded ring per symbol,
   * dropped with the quote when the symbol leaves the list.
   *
   * Prices, not rates. Every entry is already mapped through the day's anchor the quote arrived
   * with, so a tick drawn here is the same number the row above it prints and cannot be replotted
   * against a different anchor later.
   */
  const symbolTicksRef = useRef(new Map<string, Array<{ t: number; price: number }>>());
  const subscribeSymbols = useCallback((symbols: readonly string[]) => {
    watchedRef.current = [...symbols];
    // Quotes for symbols no longer watched are dropped: keeping them would let a stale price from
    // minutes ago be printed as if it were live.
    for (const sym of [...quotesRef.current.keys()]) if (!symbols.includes(sym)) quotesRef.current.delete(sym);
    for (const sym of [...symbolTicksRef.current.keys()]) if (!symbols.includes(sym)) symbolTicksRef.current.delete(sym);
    send('subscribe_symbols', { symbols: [...symbols] }); // no-op while closed; re-sent on hello
  }, [send]);
  const getSymbolQuote = useCallback((symbol: string) => quotesRef.current.get(symbol) ?? null, []);
  /**
   * One quote onto a symbol's ring. MetaTrader's own cap is 2000 ticks per symbol, so that is the
   * cap; a repeated price at the same instant is dropped, because a tick chart draws when a quote
   * CHANGED and two identical points would only thicken the step.
   */
  const pushSymbolTick = useCallback((symbol: string, t: number, price: number): void => {
    if (!Number.isFinite(price) || !Number.isFinite(t)) return;
    const ring = symbolTicksRef.current.get(symbol);
    if (!ring) { symbolTicksRef.current.set(symbol, [{ t, price }]); return; }
    const last = ring[ring.length - 1];
    if (last && last.t === t && last.price === price) return;
    ring.push({ t, price });
    if (ring.length > SYMBOL_TICK_CAP) ring.splice(0, ring.length - SYMBOL_TICK_CAP);
  }, []);
  const getSymbolTicks = useCallback(
    (symbol: string): readonly { t: number; price: number }[] => symbolTicksRef.current.get(symbol) ?? EMPTY_TICKS,
    [],
  );

  const newsWaitersRef = useRef<Array<{ resolve: (r: NewsReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>([]);
  const newsOutboxRef = useRef<Array<{ limit: number }>>([]);
  const requestNews = useCallback((limit = 40): Promise<NewsReply> => new Promise<NewsReply>((resolve, reject) => {
    // The newswire carries no request id: there is one wire and one shape of answer, so the next
    // `news` frame belongs to whoever is waiting. Everyone in the queue is served by it.
    // Asked for before the socket is ready (the News tab can be opened immediately), the frame is
    // held and flushed on open — failing outright would leave the tab permanently empty.
    if (!send('news', { limit })) newsOutboxRef.current.push({ limit });
    const timer = setTimeout(() => {
      const i = newsWaitersRef.current.findIndex((w) => w.timer === timer);
      if (i >= 0) newsWaitersRef.current.splice(i, 1)[0]!.reject(new Error('NEWS_TIMEOUT'));
    }, 20_000);
    newsWaitersRef.current.push({ resolve, reject, timer });
  }), [send]);

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
      if (m.type === 'open_position') {
        // Every order still waiting for an ack is rolled back, not just one: a queue that is
        // dropped can hold several, and each one optimistically debited the wallet.
        const pending = positionsRef.current.filter((p) => !p.positionId);
        if (pending.length) {
          for (const p of pending) clearOpenAck(p.clientId);
          setPositions((cur) => cur.filter((p) => p.positionId));
          classic = true;
          void qc.invalidateQueries({ queryKey: ['wallet'] });
        }
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
    (input: OpenPositionInput): LocalRefusal | null => {
      /**
       * No single-open rule. It was never the engine's: `GameServer.openPositionsOf` returns a list,
       * nothing in `openPosition` looks at what is already running, and every position carries its
       * own id, ticket, levels and settlement. The refusal lived here, and it made the terminal
       * refuse the one thing a terminal is for.
       */
      if (!tokenRef.current) {
        toast.push({ tone: 'error', title: 'Log in to trade' });
        return 'LOGIN_REQUIRED';
      }
      // This tab's id for this order, echoed by the engine on the ack and on a refusal, so several
      // orders can be outstanding at once and each answer lands on the order that caused it.
      const clientId = `c${++clientSeq.current}`;
      if (!sendTrade('open_position', { ...input, clientId })) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: try again shortly.' });
        return 'OFFLINE';
      }
      const last = ticksRef.current[ticksRef.current.length - 1] ?? null;
      const now = Date.now();
      setPositions((cur) => [...cur, {
        positionId: null,
        clientId,
        direction: input.direction,
        stakeCents: input.stakeCents,
        durationS: input.durationS,
        phase: 'pending',
        // No ticket yet: the database allocates it, and there is no row until the engine takes the
        // order. `ticketLabel` prints this as "…", not as a missing one.
        ticket: null,
        entryRate: last?.rate ?? null,
        expiresAtMs: now + input.durationS * 1000,
        liveMultiplier: 1,
        livePnlCents: 0,
        secondsLeft: input.durationS,
        sellable: false,
        // What was ASKED for. `position_opened` replaces these with what the engine actually took.
        slPrice: input.slPrice ?? null,
        tpPrice: input.tpPrice ?? null,
      }]);
      // Bound the wait, PER ORDER. See OPEN_ACK_TIMEOUT_MS: on firing this asks the engine rather
      // than guessing. One timer per outstanding order, keyed by its clientId, because several can
      // now be in flight and a single shared timer would disarm the previous order's guard.
      const timer = setTimeout(() => {
        openAckTimers.current.delete(clientId);
        const mine = positionsRef.current.find((p) => p.clientId === clientId);
        if (!mine || mine.positionId) return; // acked while the timer was in flight
        logJournal('warn', 'Trade', 'No acknowledgement in 8s: asking the server what is open');
        awaitingSync.current = true;
        if (!sendTrade('sync_positions', {})) {
          // The socket is gone, so nothing can answer. Roll back THIS order and let the reconnect's
          // own `open_positions` re-adopt it if the engine does hold it.
          awaitingSync.current = false;
          patchPosition({ clientId }, () => null);
          void qc.invalidateQueries({ queryKey: ['wallet'] });
          toast.push({ tone: 'error', title: 'Order not confirmed', description: 'Reconnecting: your positions will reappear if the order was taken.' });
        }
      }, OPEN_ACK_TIMEOUT_MS);
      openAckTimers.current.set(clientId, timer);
      // Optimistic debit; reconciled by the authoritative `balance` push.
      qc.setQueryData<WalletDto>(['wallet'], (old) =>
        old ? { ...old, real: Math.max(0, old.real - input.stakeCents) } : old,
      );
      return null;
    },
    [qc, send, setPositions, patchPosition, clearOpenAck, toast],
  );

  /**
   * MetaTrader's Modify position, sent to the ENGINE.
   *
   * The levels do not live here. This asks the engine to hold them, and the engine's `levels_set`
   * reply is what the UI believes afterwards, so a tab that lost a race against another device is
   * corrected rather than left showing a stop the server never took.
   */
  /**
   * Which position a per-position command acts on.
   *
   * Explicit when the caller names one, which every plural surface does (a Trade grid row, a close
   * form opened from it). Omitted it means the newest, which is what the remaining singular surfaces
   * have always meant by "the position".
   */
  const pick = useCallback((positionId?: string | null): ActivePosition | null => {
    const list = positionsRef.current;
    if (positionId == null) return list[list.length - 1] ?? null;
    return list.find((p) => p.positionId === positionId) ?? null;
  }, []);

  const setLevels = useCallback((slPrice: number | null, tpPrice: number | null, positionId?: string): boolean => {
    const a = pick(positionId);
    if (!a || !a.positionId || a.phase !== 'open') return false;
    if (!send('set_levels', { positionId: a.positionId, slPrice, tpPrice })) {
      toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: your levels were not changed.' });
      return false;
    }
    return true;
  }, [pick, send, toast]);

  /**
   * Arm a pending order at a price.
   *
   * The engine answers with `pending_placed` or an `ORDER_REJECTED` error, and the list is refreshed
   * from the engine rather than guessed at here: the authority on what is armed is the side that
   * will fill it.
   */
  const placePending = useCallback((input: PlacePendingInput): boolean => {
    if (!send('place_pending', { ...input, clientId: `po-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })) {
      toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: your order was not placed.' });
      return false;
    }
    return true;
  }, [send, toast]);

  const cancelPending = useCallback((orderId: string): boolean => {
    if (!send('cancel_pending', { orderId })) {
      toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: your order was not cancelled.' });
      return false;
    }
    return true;
  }, [send, toast]);

  const sell = useCallback((positionId?: string) => {
    const a = pick(positionId);
    if (!a || !a.positionId || a.phase !== 'open' || !a.sellable) return;
    if (!send('sell', { positionId: a.positionId })) {
      toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting. Your position auto-settles at expiry.' });
      return;
    }
    patchPosition({ positionId: a.positionId }, (p) => ({ ...p, phase: 'settling' }));
  }, [pick, patchPosition, send, toast]);

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
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: try again shortly.' });
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
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: try again shortly.' });
      }
    },
    [send, toast],
  );

  const closeMultiplier = useCallback(
    (positionId: string) => {
      if (!send('close_multiplier', { positionId })) {
        toast.push({ tone: 'error', title: 'Not connected', description: 'Reconnecting: try again shortly.' });
      }
    },
    [send, toast],
  );

  const onMultiplier = useCallback((cb: (e: MultEvent) => void) => {
    multListenersRef.current.add(cb);
    return () => { multListenersRef.current.delete(cb); };
  }, []);

  /**
   * Pre-fill the tick buffer with a smooth synthetic history so the classic shell's curve is already
   * full on load (never "fills in" from the right). Keeps emitting until the first real tick
   * arrives, then stands down so live data takes over.
   *
   * ── NEVER ON A TERMINAL ─────────────────────────────────────────────────────────────────────────
   * A terminal brand charts a PRICE: every tick is run through the day's anchor to get one. Feeding
   * it an invented rate printed a price the server never sent, and the damage was not subtle. The
   * forming candle is created from the first tick in its bucket, so a single synthetic tick landing
   * before the first real one set that bar's open, high and low tens of points away from the market;
   * the real ticks that followed pulled the close back, leaving one monstrous candle on the chart
   * with a correct close and a fabricated open. It showed up "after refreshing a few times" because
   * the window is exactly the gap between the chart's history arriving and the first live quote,
   * which is network latency: nearly zero against a local engine, wide open against a real one.
   *
   * The same invented rate was also the ticket's quoted price, the Trade grid's current-price column
   * and the phone's, so a trader could have read a made-up number and pressed Buy against it.
   *
   * So the synthesis is a classic-shell backdrop and nothing else. On a terminal the surfaces simply
   * have no quote until the engine sends one, which is the truth and is what they already render.
   */
  useEffect(() => {
    if (terminalRef.current) return;
    const curve = synthCurveRef.current ?? (synthCurveRef.current = makeSynthCurve(synthProfileRef.current));
    if (ticksRef.current.length === 0) {
      const now = Date.now();
      const origin = now - SYNTH_SPAN_MS;              // curve t=0 at the left edge of the seed window
      synthOriginRef.current = origin;
      const count = Math.floor(SYNTH_SPAN_MS / SYNTH_SPACING_MS);
      const seed: Tick[] = [];
      let prevRate = synthRate(curve(0));
      for (let i = count; i > 0; i--) {
        const t = now - i * SYNTH_SPACING_MS;
        const rate = synthRate(curve((t - origin) / 1000));
        // Labelled as invented, so nothing downstream has to infer it from timing.
        seed.push({ t, rate, delta: rate - prevRate, synthetic: true });
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
      const prevRate = buf.length > 0 ? buf[buf.length - 1]!.rate : synthRate(curve(0));
      const rate = synthRate(curve((t - synthOriginRef.current) / 1000));
      buf.push({ t, rate, delta: rate - prevRate, synthetic: true });
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
          {
            const h = data as { tradeDate?: string; serverSeedHash?: string };
            logJournal('info', 'Network', `server ready: trade date ${h.tradeDate ?? '?'}, seed ${(h.serverSeedHash ?? '').slice(0, 12)}`);
          }
          const d = data as HelloData;
          // Same rule as `fairness` below: a reconnect that lands on a new trade date must not
          // redraw yesterday's cached bars.
          if (d?.tradeDate && lastTradeDateRef.current !== null && d.tradeDate !== lastTradeDateRef.current) clearCandleCache();
          if (d?.tradeDate) lastTradeDateRef.current = d.tradeDate;
          if (d?.serverSeedHash) setFairness({ serverSeedHash: d.serverSeedHash, tradeDate: d.tradeDate });
          setEarlyCloseEnabled(d?.gameConfig?.earlyCloseEnabled === true);
          {
            const sp = d?.gameConfig?.spread;
            setSpread(sp && Number.isFinite(sp.buy) && Number.isFinite(sp.sell)
              ? { buy: sp.buy, sell: sp.sell }
              : null);
          }
          // Re-arm the instrument subscription after a (re)connect so the digits chart keeps streaming.
          if (subscribedInstrumentRef.current) send('subscribe_instrument', { instrumentId: subscribedInstrumentRef.current });
          // Same for the watch list: without this a reconnect left Market Watch frozen on the last
          // prices it saw before the drop, with no indication they had stopped moving.
          if (watchedRef.current.length > 0) send('subscribe_symbols', { symbols: [...watchedRef.current] });
          if (symbolsOutboxRef.current) { symbolsOutboxRef.current = false; send('symbols', {}); }
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
          /**
           * A new trade date means a new seed, so every cached bar belongs to a curve that is no
           * longer the one being drawn. Dropped here rather than aged out on a timer: the engine
           * says when the day turns, and nothing else can.
           */
          if (d?.tradeDate && lastTradeDateRef.current !== null && d.tradeDate !== lastTradeDateRef.current) clearCandleCache();
          if (d?.tradeDate) lastTradeDateRef.current = d.tradeDate;
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
        /**
         * What this user already had running when the socket authed, so a refresh does not hide it.
         *
         * A reload destroyed `activePosition`, which lives only in React state, and nothing re-asked
         * the engine. The contract kept running, its `position_update` frames kept arriving at the
         * new socket, and every one was dropped: that handler only ever MUTATES a position it
         * already has (`cur && cur.positionId === d.positionId`), so with nothing to attach them to
         * the live P/L, the countdown and `sellable` all went nowhere, and the trade settled into a
         * balance change the trader could not account for.
         *
         * Only taken when nothing is already active, so this can never overwrite an optimistic open
         * that the trader raised in this page's life: that one is reconciled by `position_opened`.
         * Pool and digit contracts are not here at all, because the engine holds those in their own
         * maps and this frame reports only rise/fall positions.
         */
        case 'open_positions': {
          const d = data as { positions?: readonly {
            positionId: string; ticket?: number | null; direction: Direction; stakeCents: number; durationS: number;
            openedAtMs: number; expiresAtMs: number; entryRate: number; sellable: boolean;
            slPrice?: number | null; tpPrice?: number | null;
          }[] };
          const rows = d.positions ?? [];
          /**
           * The engine's list is the TRUTH, and this reconciles the whole of it.
           *
           * Two callers, and the difference still matters. Normally this is the auth reply after a
           * reload, where the tab has nothing and every row is adopted. When the acknowledgement
           * watchdog asked (`awaitingSync`), the pending orders are exactly what has to be resolved:
           * a row the engine holds confirms one, and a pending order with no row was never taken.
           *
           * Positions the tab already has are UPDATED rather than replaced, so a live P/L and a
           * countdown already arriving are not reset to neutral by a sync. Positions the engine does
           * not list are dropped only when it is answering the watchdog; otherwise a settle that
           * raced this frame could resurrect, or a position could vanish on a partial list.
           */
          const answeringWatchdog = awaitingSync.current;
          awaitingSync.current = false;

          setPositions((cur) => {
            const byId = new Map(cur.filter((p) => p.positionId).map((p) => [p.positionId as string, p]));
            const adopted: ActivePosition[] = rows.map((r) => {
              const had = byId.get(r.positionId);
              byId.delete(r.positionId);
              if (had) {
                // Known already: take the engine's durable facts, keep the live ones still flowing.
                return {
                  ...had,
                  ticket: r.ticket ?? had.ticket,
                  sellable: r.sellable,
                  slPrice: r.slPrice ?? null,
                  tpPrice: r.tpPrice ?? null,
                };
              }
              return {
                positionId: r.positionId,
                // The engine's ticket, so a recovered position is named the same number it was
                // named before the reload rather than renumbered.
                ticket: r.ticket ?? null,
                clientId: `srv${r.positionId}`,
                direction: r.direction,
                stakeCents: r.stakeCents,
                durationS: r.durationS,
                phase: 'open' as const,
                entryRate: r.entryRate,
                expiresAtMs: r.expiresAtMs,
                /**
                 * The live figures are the engine's and arrive on its next tick, which is within one
                 * tick interval. Seeded neutral rather than guessed: a multiplier invented here
                 * would print a P/L the engine never said until the first update landed.
                 */
                liveMultiplier: 1,
                livePnlCents: 0,
                secondsLeft: Math.max(0, Math.round((r.expiresAtMs - Date.now()) / 1000)),
                sellable: r.sellable,
                // The stop the ENGINE still holds. A refreshed tab gets its levels back because the
                // engine never lost them, which is the whole reason they live there.
                slPrice: r.slPrice ?? null,
                tpPrice: r.tpPrice ?? null,
              };
            });
            // Orders still waiting for an ack. The watchdog's answer decides them; otherwise they
            // are left alone, because this frame is not evidence about an order sent after it.
            const stillPending = cur.filter((p) => !p.positionId);
            if (!answeringWatchdog) return [...byId.values(), ...adopted, ...stillPending];
            return adopted;
          });

          if (answeringWatchdog) {
            if (rows.length === 0) {
              // The engine has nothing open for this user, so the order was never taken. The
              // optimistic debit is rolled back above and said plainly here, rather than leaving
              // money committed to nothing.
              logJournal('error', 'Trade', 'The server has no such position: the order was not taken');
              void qc.invalidateQueries({ queryKey: ['wallet'] });
              toast.push({ tone: 'error', title: 'Order not accepted', description: 'The server has no record of it. Your balance is unchanged.' });
            } else {
              const last = rows[rows.length - 1]!;
              logJournal('ok', 'Trade', `#${ticketLabel({ ticket: last.ticket ?? null, positionId: last.positionId })} confirmed by the server after a lost acknowledgement`);
            }
            clearOpenAck();
          } else if (rows.length) {
            logJournal('ok', 'Trade', `${rows.length} position${rows.length === 1 ? '' : 's'} recovered after reconnect`);
          }
          break;
        }
        case 'position_opened': {
          {
            const o = data as { positionId?: string; ticket?: number | null; direction?: string; stakeCents?: number; entryRate?: number };
            logJournal('ok', 'Trade', `#${ticketLabel({ ticket: o.ticket ?? null, positionId: o.positionId ?? null })} ${o.direction} accepted at ${o.entryRate?.toFixed?.(6) ?? '?'}`);
          }
          /**
           * The sound the Settings toggle governs, on the event it names.
           *
           * "Order sounds -- a sound when an order opens and when it settles" was true of the digits
           * shell and of nothing else: `play` was called from `DigitsTradeScreen` alone, so on a
           * terminal brand -- where that row is the only sound control there is -- the setting
           * governed the live-chat chime and not one thing about an order. Here, because this is
           * where the ENGINE says an order opened, so both shells and every surface that can place
           * one are covered by the same two lines. `play` is a no-op while muted, and digits settle
           * on their own `digit_settled` frame, so nothing sounds twice.
           */
          play('place');
          const d = data as PositionOpenedData;
          /**
           * Bound to the order that caused it by the `clientId` the engine echoes back.
           *
           * With several orders outstanding, "the pending position" is ambiguous and matching by
           * arrival order would be a guess: this handler awaits the database on the engine side, so
           * two acks can arrive in either order, and pairing one order's ticket and entry price with
           * another's stake is the kind of wrong that costs money. An engine that does not echo it
           * falls back to the oldest pending order, which is exactly right when only one can exist.
           */
          const ackKey = d.clientId !== undefined && d.clientId !== null
            ? { clientId: String(d.clientId) }
            // A pending order's fill is nobody's request, so there is nothing to bind it to and the
            // fallback below must not be used: see `fromPending` in lib/game/betting.
            : d.fromPending === true
              ? { clientId: undefined }
              : { clientId: positionsRef.current.find((p) => !p.positionId)?.clientId };
          clearOpenAck(ackKey.clientId); // acknowledged: that order's watchdog has nothing to guard
          const fill = (cur: ActivePosition | null): ActivePosition => ({
            positionId: d.positionId,
            // The ticket the database allocated inside the money RPC's own INSERT. It arrives with
            // the acknowledgement, so the number is on screen the moment the trade is real.
            ticket: d.ticket ?? null,
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
            // What the engine ACTUALLY took, which can differ from what was asked (a level it
            // refused comes back null). The ack is the truth, not the optimistic copy above.
            slPrice: d.slPrice ?? null,
            tpPrice: d.tpPrice ?? null,
          });
          setPositions((cur) => {
            const i = ackKey.clientId === undefined
              ? -1
              : cur.findIndex((p) => p.clientId === ackKey.clientId && !p.positionId);
            // The order this answers is filled in place, so it keeps its position in the list and
            // the grid does not reorder under the trader's cursor as acks land.
            if (i >= 0) return cur.map((p, n) => (n === i ? fill(p) : p));
            // No pending order to attach it to: a settle-then-reopen race, or an ack for an order
            // this tab never sent (another device). Adopt it rather than drop the position.
            if (cur.some((p) => p.positionId === d.positionId)) return [...cur];
            return [...cur, fill(null)];
          });
          /**
           * No popup on a terminal brand, because MetaTrader has none.
           *
           * MetaQuotes is specific about where a result goes: "Once an order is sent, its execution
           * results will appear IN THE WINDOW: either confirmation of a successful trade or a
           * rejection with the reason specified." A confirmation is the order screen's own, and
           * after it the position itself is the confirmation — it appears on the Trade tab, in the
           * live position panel, and as a level on the chart.
           *
           * A floating card over the ticket was not only absent from MetaTrader, it painted in this
           * app's brand palette (`bg-up/10`, an accent dot), so on a green brand it arrived as a
           * green panel over MetaTrader's grey. Its wording was not MetaTrader's either: it called
           * the expiry an "Auto-sell".
           *
           * REJECTIONS still raise one, on every shell, because MetaTrader reports those: that is
           * the other half of the sentence above. They render in MetaTrader's own colours on a
           * terminal screen; see ToastProvider.
           */
          if (!terminalRef.current) {
            toast.push({
              tone: 'info',
              title: `Opened · ${d.direction === 'buy' ? 'BUY' : 'SELL'} ${formatKes(d.stakeCents)}`,
              description: `Auto-sell in ${d.durationS}s`,
            });
          }
          break;
        }
        /**
         * The engine's answer to Modify position: what it NOW holds.
         *
         * Taken as the truth rather than merged with the local request. Two devices can both move a
         * stop, and the one that lost should show the level that will actually fire, not its own.
         */
        case 'levels_set': {
          const d = data as { positionId?: string; slPrice?: number | null; tpPrice?: number | null };
          patchPosition({ positionId: d.positionId ?? null },
            (p) => ({ ...p, slPrice: d.slPrice ?? null, tpPrice: d.tpPrice ?? null }));
          break;
        }
        case 'position_update': {
          const d = data as PositionUpdateData;
          patchPosition({ positionId: d.positionId }, (p) => ({
            ...p,
            phase: p.phase === 'settling' ? 'settling' : 'open',
            liveMultiplier: d.liveMultiplier,
            livePnlCents: d.livePnlCents,
            secondsLeft: d.secondsLeft,
            sellable: d.sellable,
          }));
          break;
        }
        case 'position_settled': {
          {
            const d2 = data as { positionId?: string; result?: string; pnlCents?: number; mode?: string };
            logJournal(d2.result === 'win' ? 'ok' : 'info', 'Trade',
              `#${(d2.positionId ?? '').slice(0, 8)} closed ${d2.result} (${d2.mode}) p/l ${((d2.pnlCents ?? 0) / 100).toFixed(2)}`);
          }
          const d = data as PositionSettledData;
          // The side, for the close report. The engine states it on the settle; the local position
          // is only a fallback for an engine that predates that field, and it may itself be gone
          // (a settle arriving after a reconnect has no local position at all).
          const local = positionsRef.current.find((p) => p.positionId === d.positionId) ?? null;
          const closedDirection = d.direction ?? local?.direction;
          patchPosition({ positionId: d.positionId }, () => null);
          if (typeof d.balance === 'number') setWalletReal(d.balance);
          void qc.invalidateQueries({ queryKey: ['positions'] });
          void qc.invalidateQueries({ queryKey: ['ledger'] });
          // Refresh real + bonus + wagering progress: a settle can spend/convert bonus funds
          // (migration 0094), and only /wallet carries the authoritative bonus + wagering figures.
          void qc.invalidateQueries({ queryKey: ['wallet'] });

          const won = d.result === 'win';
          // The other half of "and when it settles". The engine's own verdict, not a local one.
          play(won ? 'win' : 'loss');
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
            ticket: d.positionId,
            direction: closedDirection,
            // The settled instrument, so the notice can print the volume to this symbol's own
            // digits without reaching back into this provider from outside it.
            symbol: marketRef.current?.instrument.symbol,
          });
          break;
        }
        case 'news': {
          const d = data as NewsReply;
          for (const w of newsWaitersRef.current.splice(0)) { clearTimeout(w.timer); w.resolve(d); }
          break;
        }
        case 'anchors': {
          const d = data as AnchorsReply & { reqId?: string };
          if (d.reqId) settleAnchorWaiter(d.reqId, { ok: d });
          break;
        }
        case 'candles': {
          const d = data as CandlesReply & { reqId?: string; symbol?: string };
          /**
           * Only the brand's DEFAULT symbol may set the shared market axis.
           *
           * Decided by which REQUEST this answers, not by comparing the reply against whatever
           * happened to arrive first. The old test was `marketRef.current === null || same symbol`,
           * which means the first reply of any symbol won: Market Watch asks for H1 bars of its
           * first visible row on mount, so a watch list that had been sorted or had its top row
           * hidden anchored the whole session on the wrong instrument, and the ticket then offered
           * to "Chart" a symbol the brand does not settle.
           */
          const forDefault = d.reqId !== undefined && defaultCandleReqsRef.current.delete(d.reqId);
          if (forDefault && d.instrument && d.anchor) {
            marketRef.current = { instrument: d.instrument, anchor: d.anchor };
            if (settledSymbolRef.current === null) settledSymbolRef.current = d.instrument.symbol;
          }
          if (d.reqId) settleCandleWaiter(d.reqId, { ok: d });
          break;
        }
        case 'symbols': {
          const d = data as SymbolsReply;
          // The engine's own word for which of the list this brand settles. It outranks the guess
          // made from the first candles reply, so a session that started before this arrived is
          // corrected rather than left on an assumption.
          if (typeof d.defaultSymbol === 'string' && d.defaultSymbol !== '') settledSymbolRef.current = d.defaultSymbol;
          for (const w of symbolsWaitersRef.current.splice(0)) { clearTimeout(w.timer); w.resolve(d); }
          break;
        }
        case 'subscribed_symbols': {
          const d = data as { symbols?: string[]; rejected?: string[]; max?: number };
          // A rejected symbol is worth saying out loud rather than leaving as a row that never
          // quotes: the Journal is where this app explains itself.
          if (d.rejected && d.rejected.length > 0) {
            logJournal('warn', 'Quotes', `not quoted (${d.rejected.length} of ${(d.symbols?.length ?? 0) + d.rejected.length}, cap ${d.max ?? '?'}): ${d.rejected.slice(0, 6).join(', ')}`);
          }
          break;
        }
        /**
         * MetaTrader's pending orders. The engine is the authority on what is armed, so every one
         * of these refreshes the list from it rather than patching a local copy: a second device,
         * a reconnect and a fill all change the book, and only one side sees all three.
         */
        case 'pending_orders': {
          const d = data as { orders?: PendingOrderDto[] };
          setPendingOrders(Array.isArray(d.orders) ? d.orders : []);
          break;
        }
        case 'pending_placed': {
          const d = data as { order?: PendingOrderDto };
          if (d.order) {
            logJournal('ok', 'Trade', `${d.order.kind} ${d.order.symbol} armed at ${d.order.triggerPrice}`);
          }
          send('pending_orders', {});
          break;
        }
        case 'pending_canceled': {
          logJournal('info', 'Trade', 'pending order cancelled');
          send('pending_orders', {});
          break;
        }
        /**
         * One reached its level. The trader armed it earlier and is very likely not watching, so it
         * is announced rather than left to be noticed: MetaTrader writes a Journal line and moves
         * the row from Orders to Trade.
         */
        case 'pending_filled': {
          const d = data as { kind?: string; symbol?: string; triggerPrice?: number; positionId?: string | null; error?: string | null };
          if (d.error) {
            logJournal('error', 'Trade', `${d.kind ?? 'pending order'} at ${d.triggerPrice ?? '?'} could not fill: ${d.error}`);
            toast.push({ tone: 'error', title: 'Order not filled', description: d.error });
          } else {
            logJournal('ok', 'Trade', `${d.kind ?? 'pending order'} ${d.symbol ?? ''} filled at ${d.triggerPrice ?? '?'}`);
            toast.push({ tone: 'info', title: 'Pending order filled', description: `${d.symbol ?? ''} at ${d.triggerPrice ?? ''}` });
          }
          send('pending_orders', {});
          break;
        }
        case 'symbol_quote': {
          // The seed for one symbol: what it is, where its axis sits, and a first price. Everything
          // the tick stream sends afterwards is read against this.
          const d = data as { symbol: string; instrument: MarketSymbol; anchor: SymbolQuote['anchor']; rate: number; t: number };
          if (!d.symbol || !d.instrument || !d.anchor) break;
          if (!watchedRef.current.includes(d.symbol)) break;
          const price = d.anchor.base + d.instrument.scale * (valueOfRate(d.rate) - d.anchor.openValue);
          const prev = quotesRef.current.get(d.symbol);
          quotesRef.current.set(d.symbol, {
            symbol: d.symbol, instrument: d.instrument, anchor: d.anchor, rate: d.rate, price, t: d.t,
            // A re-seed after a reconnect keeps the colour it had, so the whole list does not flash,
            // and the day's range it already had, which the next tick refreshes anyway.
            up: prev?.up ?? null, changedAt: prev?.changedAt ?? null,
            dayHigh: prev?.dayHigh ?? null, dayLow: prev?.dayLow ?? null,
          });
          pushSymbolTick(d.symbol, d.t, price);
          break;
        }
        case 'symbol_ticks': {
          const d = data as {
            t: number;
            quotes?: Array<{ symbol: string; rate: number; delta: number; high?: number; low?: number }>;
          };
          for (const q of d.quotes ?? []) {
            const prev = quotesRef.current.get(q.symbol);
            // No seed yet means no anchor, and a rate without its anchor cannot be priced. Dropping
            // it is right: the seed is on its way.
            if (!prev) continue;
            const price = prev.anchor.base + prev.instrument.scale * (valueOfRate(q.rate) - prev.anchor.openValue);
            const moved = price !== prev.price;
            quotesRef.current.set(q.symbol, {
              ...prev, rate: q.rate, price, t: d.t,
              up: moved ? price > prev.price : prev.up,
              changedAt: moved ? Date.now() : prev.changedAt,
              // Already prices: the engine maps them through the day's anchor, where it lives.
              // Kept from the previous quote when absent, so an engine that does not send them
              // leaves the row without an `H:`/`L:` rather than blanking one it had.
              dayHigh: typeof q.high === 'number' ? q.high : prev.dayHigh,
              dayLow: typeof q.low === 'number' ? q.low : prev.dayLow,
            });
            pushSymbolTick(q.symbol, d.t, price);
          }
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
          const d = data as WsErrorData & { reqId?: string };
          // A candle request that failed (bad timeframe, a line brand with no candles) must reject
          // its own promise rather than surface as a toast meant for trading errors.
          if (d.reqId) { settleCandleWaiter(d.reqId, { err: new Error(d.code) }); break; }
          logJournal('error', 'Server', `${d.code}${d.message ? `: ${d.message}` : ''}`);
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
          /**
           * Roll back the order the engine is refusing, by the `clientId` it echoes.
           *
           * With several orders outstanding this cannot be "the pending one": refusing order B must
           * not cancel order A, which the engine may have accepted. The engine echoes the id on the
           * refusals an order can produce; without one (an older engine, or an error belonging to
           * nothing in particular) the oldest pending order is the only safe reading, and it is the
           * right one when a single order is outstanding.
           */
          const refusedId = d.clientId !== undefined && d.clientId !== null ? String(d.clientId) : undefined;
          const refused = refusedId !== undefined
            ? positionsRef.current.find((p) => p.clientId === refusedId && !p.positionId)
            : positionsRef.current.find((p) => !p.positionId);
          if (refused) {
            // optimistic open refused → roll back and re-sync balance
            clearOpenAck(refused.clientId);
            patchPosition({ clientId: refused.clientId }, () => null);
            void qc.invalidateQueries({ queryKey: ['wallet'] });
          } else {
            // cash-out failed → restore so the user can retry / let it auto-settle
            const settling = positionsRef.current.find((p) => p.phase === 'settling');
            if (settling) patchPosition({ positionId: settling.positionId }, (p) => ({ ...p, phase: 'open' }));
          }
          const title = errorTitle(/^INSUFFICIENT_FUNDS/.test(String(d.message ?? '')) ? 'INSUFFICIENT_FUNDS' : d.code);
          const detail = friendlyError(d.message, d.reasons, fmtRef.current);
          // Recorded for the order window, which is where MetaTrader puts a rejection.
          setLastTradeError({ code: String(d.code ?? ''), title, detail, at: Date.now() });
          /**
           * The popup only where nothing else will say it.
           *
           * An order window that is waiting prints this same rejection itself, in MetaTrader's own
           * place for it: "its execution results will appear in the window". Raising a card over
           * that window is one tap answered twice, in two different visual languages. Where no
           * window is waiting — the one-click panel firing instantly, the desktop shell, a refusal
           * that is nobody's order — the popup is the only surface a rejection has and it stays.
           */
          if (!orderWindowWaiting()) toast.push({ tone: 'error', title, description: detail });
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
        logJournal('ok', 'Network', 'connected to the trade server');
        // Chart history asked for before the socket was ready (see candleOutboxRef).
        for (const frame of candleOutboxRef.current.splice(0)) ws.send(JSON.stringify({ type: 'candles', data: frame }));
        for (const frame of newsOutboxRef.current.splice(0)) ws.send(JSON.stringify({ type: 'news', data: frame }));
        for (const frame of anchorOutboxRef.current.splice(0)) ws.send(JSON.stringify({ type: 'anchors', data: frame }));
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
        candleOutboxRef.current.length = 0;
        newsOutboxRef.current.length = 0;
        anchorOutboxRef.current.length = 0;
        for (const [id] of anchorWaitersRef.current) settleAnchorWaiter(id, { err: new Error('SOCKET_CLOSED') });
        for (const w of newsWaitersRef.current.splice(0)) { clearTimeout(w.timer); w.reject(new Error('NOT_CONNECTED')); }
        dropCandleWaiters('NOT_CONNECTED');
        digitAwaitingRef.current = 0;
        if (!closedRef.current) {
          setStatus('closed');
          logJournal('warn', 'Network', 'disconnected: reconnecting');
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
    getTicks, getLastTick, openPosition, setLevels, sell, getInstrumentTicks, getLastInstrumentTick, subscribeInstrument,
    openDigit, onDigitSettled, onDigitRejected, onDigitOpened, openMultiplier, closeMultiplier, onMultiplier,
    requestCandles, getMarket, requestNews, requestAnchors,
    requestSymbols, subscribeSymbols, getSymbolQuote, getSymbolTicks, getSettledSymbol,
    placePending, cancelPending,
  }), [getTicks, getLastTick, openPosition, setLevels, sell, getInstrumentTicks, getLastInstrumentTick, subscribeInstrument,
    openDigit, onDigitSettled, onDigitRejected, onDigitOpened, openMultiplier, closeMultiplier, onMultiplier,
    requestCandles, getMarket, requestNews, requestAnchors,
    requestSymbols, subscribeSymbols, getSymbolQuote, getSymbolTicks, getSettledSymbol,
    placePending, cancelPending]);
  const stateValue = useMemo<GameSocketState>(() => ({ status, online, fairness, activePosition, positions, earlyCloseEnabled, spread, pendingOrders, lastTradeError }), [status, online, fairness, activePosition, positions, earlyCloseEnabled, spread, pendingOrders, lastTradeError]);

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
