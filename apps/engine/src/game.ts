import {
  CurveGenerator, SettlementEngine, type GameConfig, type VersionedGameConfig,
  type Direction, type Outcome, type Tick, presentOutcome, type OutcomePresentation,
  settleDigit, type DigitKind,
  InstrumentFeed, instrumentById, isKnownInstrument, DEFAULT_INSTRUMENT_ID, digitPayoutFactor,
  digitReturnCents, decisionDigit, withLastPip, poolMultiplierDurationMs,
  seededWin, decideDigitAtWinRate,
  multiplierPnlCents, evaluateMultiplier, dealCancellationFeeCents, livePriceMultiplier,
  priceAtRate, type PriceAxis,
  type MultiplierState, type MultDir, type MultCloseReason,
} from "@invest254/shared";
import type { GameRepository } from "./wallet.js";
import { PendingOrders, type PendingOrder, type PendingOrderStore } from "./pending.js";
import { overrideAffectsPricing, userSettlement, type UserOverride } from "./overrides.js";
import type { PoolController } from "./poolcontroller.js";
import { eatDay as poolEatDay } from "./poolcontroller.js";

/** Pool-brain integration (docs/25). When `enabled()` and the player is not a marketer, the
 *  controller decides the outcome + budget instead of the statistical settlement. Optional: when
 *  absent (default / non-pool brands), the engine behaves exactly as before. */
export interface PoolIntegration { enabled: () => boolean; controller: PoolController; }

/** Async provider of a user's admin overrides (null = none). Injected so the money engine stays testable. */
export type LoadOverride = (userId: string) => Promise<UserOverride | null>;

export interface Position {
  id: string; userId: string; stakeCents: number; direction: Direction; durationS: number;
  openedAtMs: number; expiresAtMs: number; entryT: number;
  outcome: Outcome;                       // committed at open; kept server-side only (never persisted pre-settle)
  status: "open" | "settled";
  sellable: boolean;
  gameDayId: number | null;               // the day whose seed determined this outcome
  configVersion: number;                  // the game_config version that priced this outcome
  nonce: number;                          // per-position seed nonce (engagement + pool path/decision)
  poolControlled: boolean;                // docs/25: outcome decided by the pool controller, not the curve
  /**
   * Settled on the CONTINUOUS payout, so a stop and a target close it at a real price.
   *
   * False keeps the committed-outcome contract exactly as it was: the pool path (where the
   * controller, not the curve, decides) and any brand with no price axis to put a level on. See
   * docs/mt5/20-real-sl-tp.md for why the two models cannot be the same one.
   */
  continuous: boolean;
  /** MetaTrader's protective levels, as PRICES on the chart. Null means not set. */
  slPrice: number | null;
  tpPrice: number | null;
  /**
   * MetaTrader's TICKET (migration 0184): the number the trader knows this position by.
   *
   * `id` is the uuid every internal path keys on and stays that way; this is the one that goes on
   * screen, into a close confirmation and into a support call. Carried on the position rather than
   * looked up per frame so a re-armed position keeps the same number across a restart. Null means
   * the row predates the column or its read-back missed, which every surface prints as a dash.
   */
  ticket: number | null;
}
/** What ended a continuous position, which is MetaTrader's own vocabulary for a closed deal. */
export type CloseReason = "sl" | "tp" | "horizon";
export interface SettledEvent {
  position: Position; lockedMultiplier: number; payoutCents: number; pnlCents: number;
  balance: number; mode: "auto" | "manual"; presentation: OutcomePresentation;
  /** Absent on a committed contract, which has only ever ended one way. */
  closedBy?: CloseReason;
}
export interface UpdateEvent { positionId: string; liveMultiplier: number; livePnlCents: number; secondsLeft: number; sellable: boolean; }
type Listener = {
  onTick?: (t: Tick) => void;
  onUpdate?: (u: UpdateEvent) => void;
  onSettled?: (e: SettledEvent) => void;
  onError?: (err: Error, ctx: string) => void;
  /**
   * A pending order reached its level and became a position, or tried and could not.
   *
   * Its own event rather than a position event, because the trader is being told about something
   * they armed earlier and are probably not watching: MetaTrader reports the fill in the Journal
   * and moves the row from Orders to Trade, and a terminal cannot do either without being told.
   */
  onPendingFilled?: (e: {
    order: PendingOrder;
    positionId: string | null;
    /**
     * The position the order became, so a client can add it to its Trade grid at once.
     *
     * Carried rather than left to the client to go and fetch: `position_opened` is otherwise only
     * ever sent as the reply to a client's OWN `open_position`, so a position the engine opened by
     * itself would not appear anywhere until the tab was reloaded. A trader who armed an order and
     * watched it fill would see the row vanish from Orders and nothing take its place.
     */
    position: Position | null;
    error: string | null;
  }) => void;
};

/**
 * The active trading day, supplied to the GameServer on every tick/open. Decoupling the
 * server from a fixed (curve, settlement, dayStart) lets the SeedManager rotate the day
 * at the UTC boundary without rebuilding the server, and lets recovery re-arm positions
 * from prior days. `settlement.liveWinMultiplier` is day-agnostic, so re-armed positions
 * from an earlier day still render and settle correctly against the active settlement.
 */
export interface ActiveContext {
  curve: CurveGenerator;
  settlement: SettlementEngine;
  dayStartMs: number;
  gameDayId: number | null;
  /** The day seed (kept server-side) for deterministic per-position engagement draws. */
  seed?: string | null;
  /** The game_config version baked into `curve`/`settlement`; recorded on every position. */
  configVersion: number;
  /** Multi-tenant: the brand this context prices for. Stamped on every position it opens. */
  siteId?: string;
}
export type ActiveContextProvider = () => ActiveContext;

let nonceCounter = 0;

/** Clamp a prediction/barrier digit to 0..9. */
function clampTargetDigit(d: number): number {
  const n = Math.trunc(d);
  return n < 0 ? 0 : n > 9 ? 9 : n;
}

export class GameServer {
  private positions = new Map<string, Position>();
  /** Phase 2: in-flight digit contracts awaiting their 1-tick settlement (server-side only). */
  private digitContracts = new Map<string, { userId: string; stakeCents: number; kind: DigitKind; target: number; instrumentId: string; openIndex: number; settleIndex: number; openedAtMs: number; siteId: string | null; decided: { result: "win" | "loss"; payoutCents: number; digit: number } | null; poolReserved: boolean }>();
  /** Per-(daySeed, instrument) authoritative feed cache; feeds are pure/deterministic and cheap. */
  private feeds = new Map<string, InstrumentFeed>();
  /** Phase 2: open (running) multiplier contracts — statistical (feed-evaluated) or pool-decided. */
  private multiplierContracts = new Map<string, { userId: string; siteId: string | null; stakeCents: number; instrumentId: string; openedAtMs: number; nonce: number; state: MultiplierState; decided: { result: "win" | "loss"; payoutCents: number; durationMs: number } | null; poolReserved: boolean }>();
  private listeners = new Set<Listener>();
  private lastRate?: number;
  private tickTimer: NodeJS.Timeout | undefined;
  private stepping = false;

  /** tickRateMs the running interval was created with, so we only reschedule on a real change. */
  private tickRateMs: number | undefined;

  /**
   * `getConfig` is a provider rather than a value: game configuration is edited live in the
   * admin panel, and every read below must see the current row instead of a snapshot frozen
   * at process boot (which is precisely the bug this replaced).
   */
  constructor(
    private readonly getActiveContext: ActiveContextProvider,
    private readonly repo: GameRepository,
    private readonly getConfig: () => GameConfig | VersionedGameConfig,
    private readonly now: () => number = () => Date.now(),
    /** Optional per-user admin overrides (J8): win rate / max multiplier / duration / stake bounds. */
    private readonly loadOverride?: LoadOverride,
    /** Optional pool-brain integration (docs/25). Governs non-marketer trades when enabled. */
    private readonly pool?: PoolIntegration,
    /**
     * Canonical "is this a demo/marketer account?" resolver (migration 0084: fn_is_marketer_account).
     * When provided it is the SINGLE source of truth for marketer classification, so the pool
     * exemption (here) and the money routing (fn_open/settle_position -> demo_balance) can never
     * disagree. Absent (tests/back-compat) -> fall back to the JWT `role` claim.
     */
    private readonly loadIsMarketer?: (userId: string) => Promise<boolean>,
    /**
     * This brand's price axis, so the engine can tell whether a protective level has been reached.
     *
     * A level is a PRICE on the chart; the engine works in curve rates. Rather than invert the
     * axis (which is not invertible across a day boundary, and is the whole reason execution prices
     * are stamped at all), every tick converts the CURRENT rate to a price and compares. Absent on a
     * brand that charts a line, which therefore has no levels and keeps the committed contract.
     */
    private readonly priceAxis?: () => PriceAxis,
    /**
     * Where pending orders are kept, so a deploy does not disarm them (migration 0185).
     *
     * Optional, like every other persistence seam here: absent means this brand holds its orders in
     * memory for the life of the process, which is what every test fake and the in-memory
     * development repository do.
     */
    pendingStore?: PendingOrderStore,
    private readonly siteId: string | null = null,
  ) {
    this.pending = new PendingOrders(
      pendingStore ?? {},
      siteId,
      async (order, direction) => {
        const { position } = await this.openPosition({
          userId: order.userId,
          stakeCents: order.stakeCents,
          direction,
          durationS: order.durationS,
          slPrice: order.slPrice,
          tpPrice: order.tpPrice,
        });
        return { positionId: position.id };
      },
      this.now,
    );
  }

  /** The orders armed at a price, waiting for the market. See apps/engine/src/pending.ts. */
  readonly pending: PendingOrders;

  /**
   * The price a level is measured against right now, or null when this brand has no axis.
   *
   * Never throws. The axis is built from the brand's day chain, which can be absent, mid-rebuild or
   * simply not ready on the first ticks after boot, and this runs inside the tick loop: letting it
   * throw would stop the price stream for everyone to protect a level that nobody may even have
   * set. Null means "no level can be judged this tick", so a stop waits for the next one. This is
   * the same rule `withPriceStamp` states for its own writes, that a display concern is never worth
   * a trade.
   */
  private priceNow(rate: number, atMs: number): number | null {
    try {
      const axis = this.priceAxis?.();
      return axis ? priceAtRate(axis, atMs, rate) : null;
    } catch {
      return null;
    }
  }

  /**
   * Which protective level, if either, this tick has reached.
   *
   * MetaTrader's rule, and the only one that is fair when both could be read as hit in the same
   * tick: a BUY stops out at or below its stop and takes profit at or above its target, and a SELL
   * is the mirror. The stop is checked FIRST, because a tick that spans both levels cannot be known
   * to have touched the better one first and the trader is not given the benefit of that doubt.
   */
  private levelHit(p: Position, price: number): "sl" | "tp" | null {
    const long = p.direction === "buy";
    if (p.slPrice !== null && (long ? price <= p.slPrice : price >= p.slPrice)) return "sl";
    if (p.tpPrice !== null && (long ? price >= p.tpPrice : price <= p.tpPrice)) return "tp";
    return null;
  }

  /** Per-user pricing settlements, cached by (configVersion, gameDay, winRate, maxMultiplier). */
  private readonly userSettlementCache = new Map<string, SettlementEngine>();

  /**
   * The SettlementEngine that prices THIS user's round. For a pricing override (win rate / cap)
   * a per-user engine is built once and cached; an infeasible override safely falls back to the
   * global engine. Non-override users always get the global engine.
   */
  private settlementFor(ctx: ActiveContext, ov: UserOverride | null): SettlementEngine {
    if (!overrideAffectsPricing(ov)) return ctx.settlement;
    const o = ov!;
    const key = `${ctx.configVersion}:${ctx.gameDayId}:${o.winRate ?? "g"}:${o.maxWinMultiplier ?? "g"}:${o.houseEdge ?? "g"}`;
    let s = this.userSettlementCache.get(key);
    if (!s) {
      s = userSettlement(ctx.curve, this.cfg, o) ?? ctx.settlement;
      this.userSettlementCache.set(key, s);
    }
    return s;
  }

  /** The configuration in force right now. */
  private get cfg(): GameConfig { return this.getConfig(); }

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emitTick(t: Tick) { for (const l of this.listeners) l.onTick?.(t); }
  private emitUpdate(u: UpdateEvent) { for (const l of this.listeners) l.onUpdate?.(u); }
  private emitSettled(e: SettledEvent) { for (const l of this.listeners) l.onSettled?.(e); }
  private emitPendingFilled(e: { order: PendingOrder; positionId: string | null; error: string | null }) {
    const position = e.positionId === null ? null : this.positions.get(e.positionId) ?? null;
    for (const l of this.listeners) l.onPendingFilled?.({ ...e, position });
  }

  /**
   * The price right now, on this brand's own axis.
   *
   * Exposed because a pending order's level has to be checked against the market BEFORE it is
   * armed, and the only price that can do that is the engine's: the browser's is a tick or two old,
   * and an order placed against a stale price is an order that fills the instant it is made. Null
   * when no price can be known this moment, which is what `priceNow` already means.
   */
  priceRightNow(): number | null {
    return this.lastRate === undefined ? null : this.priceNow(this.lastRate, this.now());
  }

  /**
   * The symbol this brand's price axis is on, which is the symbol a pending order's level belongs
   * to. Null on a brand with no axis, which therefore has no pending orders either.
   *
   * Public because the socket layer has to refuse an order on any OTHER symbol: the tick sweep
   * only ever offers this one to `pending.step`, so an order armed on a different instrument
   * would sit in the book forever — armed, listed, and unfillable.
   */
  tradedSymbol(): string | null {
    try { return this.priceAxis?.().instrument.symbol ?? null; } catch { return null; }
  }
  private emitError(err: Error, ctx: string) { for (const l of this.listeners) l.onError?.(err, ctx); }

  start(): void {
    if (this.tickTimer) return;
    this.tickRateMs = this.cfg.tickRateMs;
    this.tickTimer = setInterval(() => { void this.step(); }, this.tickRateMs);
  }
  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    this.tickRateMs = undefined;
  }

  /**
   * Re-arm the tick loop when the configured tick rate changes. setInterval captures its
   * period at creation, so a live tick-rate edit needs the timer torn down and recreated;
   * without this the admin's "Tick rate (ms)" field would be silently inert until redeploy.
   * Returns true when the loop was actually rescheduled.
   */
  applyTickRate(): boolean {
    const next = this.cfg.tickRateMs;
    if (!this.tickTimer || next === this.tickRateMs) return false;
    clearInterval(this.tickTimer);
    this.tickRateMs = next;
    this.tickTimer = setInterval(() => { void this.step(); }, next);
    return true;
  }

  /** Current tick period in ms, or undefined when the loop is stopped. Exposed for tests/health. */
  currentTickRateMs(): number | undefined { return this.tickRateMs; }

  async step(): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const ctx = this.getActiveContext();
      const nowMs = this.now();
      const tick = ctx.curve.tick(nowMs, ctx.dayStartMs, this.lastRate);
      this.lastRate = tick.rate;
      this.emitTick(tick);
      const expired: Position[] = [];
      /** Positions a protective level has reached this tick, with which level it was. */
      const stopped: Array<{ p: Position; reason: "sl" | "tp" }> = [];
      /**
       * The chart price, resolved AT MOST ONCE a tick and only when some position has a level on it.
       *
       * `priceAxis()` reaches into the brand's day chain, which is far more work than a tick loop
       * should do unconditionally: computing it every tick regardless slowed the stream enough to
       * fail two multiengine tests outright. Nobody with a stop set pays for this, and nobody
       * without one pays for it at all.
       */
      let price: number | null | undefined;
      const priceThisTick = (): number | null => {
        if (price === undefined) price = this.priceNow(tick.rate, nowMs);
        return price;
      };
      for (const p of this.positions.values()) {
        if (p.status !== "open") continue;
        if (nowMs >= p.expiresAtMs) { expired.push(p); continue; }
        // MetaTrader's protective levels, checked on the engine rather than in a browser tab. A
        // stop that only exists on the client is not a stop: closing the tab would disarm it.
        if (p.continuous && (p.slPrice !== null || p.tpPrice !== null)) {
          const now = priceThisTick();
          const hit = now === null ? null : this.levelHit(p, now);
          if (hit) { stopped.push({ p, reason: hit }); continue; }
        }
        const g = (nowMs - p.openedAtMs) / (p.durationS * 1000);
        const live = this.liveMultiplier(p, g, ctx.settlement);
        this.emitUpdate({ positionId: p.id, liveMultiplier: live, livePnlCents: Math.round(p.stakeCents * live) - p.stakeCents, secondsLeft: Math.max(0, (p.expiresAtMs - nowMs) / 1000), sellable: p.sellable });
      }
      /**
       * Pending orders, on the same tick and against the same price as the protective levels.
       *
       * After the sweep above rather than inside it, so a fill cannot open a position that the same
       * loop then iterates over half-built. Skipped entirely when nothing is armed, which is the
       * usual case and costs one map lookup.
       */
      if (this.pending.size > 0) {
        const price = priceThisTick();
        const symbol = this.tradedSymbol();
        if (price !== null && symbol !== null) {
          try {
            for (const { order, outcome } of await this.pending.step(symbol, price)) {
              this.emitPendingFilled({
                order,
                positionId: outcome.ok ? outcome.positionId : null,
                error: outcome.ok ? null : outcome.reason,
              });
            }
          } catch (err) { this.emitError(err as Error, "pending-step"); }
        }
      }
      for (const { p, reason } of stopped) {
        try { await this.closeAtLevel(p, reason); } catch (err) { this.emitError(err as Error, `level-close ${p.id}`); }
      }
      for (const p of expired) { try { await this.settleAuto(p); } catch (err) { this.emitError(err as Error, `auto-settle ${p.id}`); } }
    } finally { this.stepping = false; }
  }

  /**
   * The floating value of an open contract, driven by the PRICE.
   *
   * It used to be a function of elapsed time and the seed alone: a winner rose monotonically on a
   * smoothstep whatever the price did, a loser decayed the same way, and a pool contract followed a
   * seeded reversing feint. None of the three took the trade's DIRECTION, so a buy and a sell
   * opened in the same second drew the same shape. On a terminal that is wrong: a buy whose price
   * is falling has to show a falling profit.
   *
   * `livePriceMultiplier` carries the argument in full. Two things decide what this method has to
   * hand it:
   *
   *   `cap` — the committed multiplier, but only where a manual close can succeed. Closing early
   *   locks whatever is displayed, and the settlement engine's guarantee is that it "can only
   *   REDUCE player payout (house edge >= target)", so a price spike must not be shown or paid
   *   above where the contract settles. Pool brands refuse every close, so they pass no cap and
   *   their path may run above its endpoint and come back, which is the feint the old code faked.
   *
   *   The DAY. The live move is read off the active day's curve, and a position re-armed from an
   *   earlier day (recovery across a UTC boundary) has an `entryT` measured against that day's
   *   start. Reading today's curve at it would price a second that never happened for this
   *   contract. Those positions keep the old time-only path, which is day-agnostic by design: see
   *   ActiveContext. They expire within a contract's length of being re-armed.
   */
  private liveMultiplier(p: Position, g: number, settlement: SettlementEngine): number {
    const ctx = this.getActiveContext();
    const ownDay = p.gameDayId === null || p.gameDayId === ctx.gameDayId;
    // A continuous contract shows exactly what closing right now would pay. There is no committed
    // endpoint to converge to and no cap derived from a decision already taken, so the live figure
    // and the settlement are the same function read at the same moment: what you see is what a stop
    // or a target would get you. A position re-armed from an earlier day keeps the old path below,
    // for the reason the day note gives.
    if (p.continuous && ownDay) return settlement.valueAt(p.direction, p.entryT, this.elapsedS(p));
    if (ownDay) {
      const elapsedS = Math.min(p.durationS, Math.max(0, g * p.durationS));
      return livePriceMultiplier({
        move: settlement.moveAt(p.direction, p.entryT, elapsedS),
        gain: settlement.gainFor(p.direction),
        endpoint: p.outcome.result === "win" ? p.outcome.multiplier : 0,
        g,
        maxMultiplier: this.cfg.maxMultiplier,
        // No cap where a close is refused outright, which is every pool brand.
        ...(this.pool?.enabled() ? {} : { cap: p.outcome.result === "win" ? p.outcome.multiplier : undefined }),
      });
    }
    // ── Re-armed from an earlier day: the old, day-agnostic paths ──
    if (p.poolControlled && this.pool) {
      return this.pool.controller.live(
        { result: p.outcome.result, multiplier: p.outcome.multiplier, payoutCents: p.outcome.payoutCents },
        ctx.seed ?? "", p.nonce, g);
    }
    if (p.outcome.result === "win") return settlement.liveWinMultiplier(p.outcome.multiplier, g);
    const x = Math.min(1, Math.max(0, g));
    return 1 - x * x * x * (x * (x * 6 - 15) + 10);
  }

  /** Open a position: outcome committed in memory; stake+position+ledger persisted atomically by the repo. */
  async openPosition(input: {
    userId: string; stakeCents: number; direction: Direction; durationS?: number; role?: string;
    /** MetaTrader's protective levels, as chart prices, armed with the order itself. */
    slPrice?: number | null; tpPrice?: number | null;
  }): Promise<{ position: Position; balance: number }> {
    // docs/25: when the brand is in pool mode, NON-marketer trades are governed by the pool
    // controller (not the curve) and admin overrides are IGNORED for them (decision E). Marketers
    // keep the statistical path WITH their overrides and are pool-exempt (decision F).
    // Canonical marketer classification (migration 0084): prefer the authoritative predicate so the
    // pool exemption matches the money layer's demo routing exactly; fall back to the role claim.
    const isMarketer = this.loadIsMarketer ? await this.loadIsMarketer(input.userId) : (input.role === "marketer");
    const poolActive = this.pool?.enabled() ?? false;
    const poolPath = poolActive && !isMarketer;
    const ov = (this.loadOverride && (!poolActive || isMarketer)) ? await this.loadOverride(input.userId) : null;
    /**
     * The horizon is the BRAND's, not the trader's.
     *
     * It used to be picked per order from an Expiry control, because the contract's whole character
     * was its term. With real protective levels a position ends when its stop or target is reached,
     * when the trader closes it, or at this backstop, and letting the trader also set the backstop
     * would be two contradictory ways to end one trade. A brand with a price axis therefore ignores
     * what the client asked for and uses its own configured horizon; everything else keeps the old
     * per-order duration exactly. The economics are unaffected: the calibration re-solves for
     * whatever horizon it is given, and RTP measures 24.97-25.47% against a 25% target from a 10
     * second horizon out to an hour.
     */
    const horizon = ov?.tradeDurationS ?? this.cfg.defaultDurationS;
    const durationS = this.priceAxis !== undefined ? horizon : (input.durationS ?? horizon);
    const minStake = ov?.minStakeCents ?? this.cfg.minStakeCents;
    const maxStake = ov?.maxStakeCents ?? this.cfg.maxStakeCents;
    if (!Number.isInteger(input.stakeCents)) throw new RangeError("stake must be integer cents");
    if (input.stakeCents < minStake) throw new Error(`STAKE_BELOW_MIN: min ${minStake}`);
    if (input.stakeCents > maxStake) throw new Error(`STAKE_ABOVE_MAX: max ${maxStake}`);
    if (durationS <= 0) throw new RangeError("duration must be > 0");
    const ctx = this.getActiveContext();
    const openedAtMs = this.now();
    const entryT = (openedAtMs - ctx.dayStartMs) / 1000;
    const nonce = (nonceCounter = (nonceCounter + 1) % Number.MAX_SAFE_INTEGER);

    // ── Pool path (docs/25): stake is debited + position row created first (as always), THEN the
    //    controller decides+reserves keyed by the real position id. The shared curve entry/exit rate
    //    remain as cosmetic backdrop; the win/loss/amount come from the pool controller. SELL is
    //    disabled in pool mode (decision B), so the position is not sellable. ──
    if (poolPath && this.pool && ctx.seed) {
      const entryRate = ctx.curve.rate(entryT);
      const exitRate = ctx.curve.rate(entryT + durationS);
      const { positionId, newBalance, ticket } = await this.repo.openPosition({
        userId: input.userId, stakeCents: input.stakeCents, direction: input.direction,
        entryRate, durationS, gameDayId: ctx.gameDayId, nonce, openedAtMs,
        configVersion: ctx.configVersion, siteId: ctx.siteId ?? null,
      });
      const po = await this.pool.controller.decideReserve({
        siteId: ctx.siteId ?? "", userId: input.userId, stakeCents: input.stakeCents,
        positionId, nonce, openedAtMs, maxMultiplier: this.cfg.maxMultiplier, serverSeed: ctx.seed,
        balanceAfterStakeCents: newBalance, minWithdrawalCents: this.cfg.minWithdrawalEffectiveCents ?? this.cfg.minWithdrawalCents,
        // Pool RTP is driven by the operator's house edge (unified config): targetSessionRtp = 1 - edge.
        targetRtp: Math.min(0.95, Math.max(0.05, 1 - this.cfg.houseEdge)),
        // Win frequency unified with the statistical engine (docs/25): the pool derives its mean
        // winning multiplier from (targetRtp, targetWinRate) so both engines share this knob.
        targetWinRate: this.cfg.targetWinRate,
      });
      const payoutCents = po.result === "win" ? po.payoutCents : 0;
      const outcome: Outcome = {
        result: po.result, multiplier: po.result === "win" ? po.multiplier : 0,
        payoutCents, pnlCents: payoutCents - input.stakeCents, entryRate, exitRate, signedMove: 0,
      };
      const p: Position = {
        id: positionId, userId: input.userId, stakeCents: input.stakeCents, direction: input.direction,
        durationS, openedAtMs, expiresAtMs: openedAtMs + durationS * 1000, entryT, outcome,
        status: "open", sellable: false, gameDayId: ctx.gameDayId, configVersion: ctx.configVersion,
        nonce, poolControlled: true,
        // The pool controller decides this trade, not the curve, so there is no price for a level
        // to be measured against and no continuous value to close at. docs/25 decision B already
        // refuses a manual close here for the same reason.
        continuous: false, slPrice: null, tpPrice: null,
        ticket: ticket ?? null,
      };
      this.positions.set(positionId, p);
      return { position: p, balance: newBalance };
    }

    // ── Statistical path (pool off, or marketers) — unchanged behaviour ──
    const engine = this.settlementFor(ctx, ov);
    const outcome = ctx.seed
      ? engine.settleVariable(input.stakeCents, input.direction, entryT, nonce, ctx.seed)
      : engine.settle(input.stakeCents, input.direction, entryT);
    const { positionId, newBalance, ticket } = await this.repo.openPosition({
      userId: input.userId, stakeCents: input.stakeCents, direction: input.direction,
      entryRate: outcome.entryRate, durationS, gameDayId: ctx.gameDayId, nonce, openedAtMs,
      configVersion: ctx.configVersion, siteId: ctx.siteId ?? null,
    });
    // A brand with a price axis settles on the CONTINUOUS payout, so its stop and target close the
    // position at a real price. One without (a line brand) has nothing to put a level on and keeps
    // the committed contract exactly as it was. See docs/mt5/20-real-sl-tp.md.
    const continuous = this.priceAxis !== undefined;
    const p: Position = {
      id: positionId, userId: input.userId, stakeCents: input.stakeCents, direction: input.direction,
      durationS, openedAtMs, expiresAtMs: openedAtMs + durationS * 1000, entryT, outcome,
      status: "open", sellable: continuous || outcome.result === "win",
      gameDayId: ctx.gameDayId, configVersion: ctx.configVersion, nonce, poolControlled: false,
      continuous,
      slPrice: continuous && Number.isFinite(input.slPrice as number) ? input.slPrice ?? null : null,
      tpPrice: continuous && Number.isFinite(input.tpPrice as number) ? input.tpPrice ?? null : null,
      ticket: ticket ?? null,
    };
    this.positions.set(positionId, p);
    // Levels sent WITH the order are persisted too, or a restart in the first seconds of a trade
    // would lose exactly the stop the trader opened with.
    if (p.slPrice !== null || p.tpPrice !== null) this.persistLevels(p);
    return { position: p, balance: newBalance };
  }

  /** The active brand's DIGIT payout factor (Deriv-style; NOT the rise/fall houseEdge). */
  private digitFactor(): number { return digitPayoutFactor(this.cfg); }

  /** Cached authoritative feed for (active day seed, instrument). Pure & deterministic. */
  private feedFor(seed: string, instrumentId: string): InstrumentFeed {
    const key = `${seed}:${instrumentId}`;
    let f = this.feeds.get(key);
    if (!f) { f = new InstrumentFeed(seed, instrumentById(instrumentId)); this.feeds.set(key, f); }
    return f;
  }

  /** The authoritative tick for an instrument at the current wall clock (for streaming/preview). */
  instrumentTick(instrumentId: string, index?: number) {
    const ctx = this.getActiveContext();
    if (!ctx.seed) throw new Error("NO_SEED");
    const feed = this.feedFor(ctx.seed, instrumentId);
    const i = index ?? feed.indexAt(this.now(), ctx.dayStartMs);
    return { ...feed.tickAt(i), tickMs: feed.instrument.tickMs, dayStartMs: ctx.dayStartMs };
  }

  /**
   * Open a Deriv-style DIGIT contract (Phase 2), server-authoritative over PER-INSTRUMENT feeds.
   *
   * Two governance paths, mirroring openPosition exactly (docs/25):
   *  - POOL PATH (brand pool_mode ON + non-marketer): the outcome is decided by the SAME
   *    PoolController brain as rise/fall — decide → atomically RESERVE the fixed payout → commit at
   *    settle. Fixed odds pay in full or lose; every clamp (pool cash fuse, no-scoop share, hard RTP
   *    budget ⌊(1−houseEdge)×turnover⌋) is a loss, so digits and rise/fall share ONE central budget
   *    per brand (withdrawal_pool row, turnover, position_decision audit). The displayed digit is
   *    drawn (seeded) from the digits CONSISTENT with the decision.
   *  - STATISTICAL PATH (pool off, or marketers/demo): provably-fair uniform digit
   *    `digitAt(daySeed, instrument, settleIndex)`; RTP = digit payout factor. Marketers stake demo
   *    funds and must never draw the real-cash pool (decision F).
   * Admin overrides do NOT apply to digits. Stake+position+ledger persist atomically
   * (fn_open_contract); settlement reuses fn_settle_position. One open digit contract per
   * (user, instrument) — matches the single-in-flight UI and keeps per-user tick overrides coherent.
   */
  async openDigitContract(input: { userId: string; stakeCents: number; kind: DigitKind; target?: number | undefined; instrumentId?: string | undefined; ticks?: number | undefined; role?: string | undefined }): Promise<{ positionId: string; balance: number; entryRate: number; instrumentId: string; openIndex: number; settleIndex: number; poolControlled: boolean }> {
    if (!Number.isInteger(input.stakeCents)) throw new RangeError("stake must be integer cents");
    if (input.stakeCents < this.cfg.minStakeCents) throw new Error(`STAKE_BELOW_MIN: min ${this.cfg.minStakeCents}`);
    if (input.stakeCents > this.cfg.maxStakeCents) throw new Error(`STAKE_ABOVE_MAX: max ${this.cfg.maxStakeCents}`);
    const instrumentId = input.instrumentId ?? DEFAULT_INSTRUMENT_ID;
    if (!isKnownInstrument(instrumentId)) throw new Error("INVALID_INSTRUMENT");
    for (const c of this.digitContracts.values()) {
      if (c.userId === input.userId && c.instrumentId === instrumentId) throw new Error("CONTRACT_EXISTS: one open digit contract per instrument");
    }
    const ticks = Math.max(1, Math.min(10, Math.trunc(input.ticks ?? 1)));
    const target = clampTargetDigit(input.target ?? 0);
    const ctx = this.getActiveContext();
    if (!ctx.seed) throw new Error("NO_SEED");
    const feed = this.feedFor(ctx.seed, instrumentId);
    const openedAtMs = this.now();
    const openIndex = feed.indexAt(openedAtMs, ctx.dayStartMs);
    const settleIndex = openIndex + ticks;
    const entryRate = feed.tickAt(openIndex).quote;
    const nonce = (nonceCounter = (nonceCounter + 1) % Number.MAX_SAFE_INTEGER);

    // Canonical marketer classification — identical to openPosition so pool exemption can never
    // diverge from the money layer's demo routing (migration 0084).
    const isMarketer = this.loadIsMarketer ? await this.loadIsMarketer(input.userId) : (input.role === "marketer");
    const poolPath = (this.pool?.enabled() ?? false) && !isMarketer;

    const { positionId, newBalance } = await this.repo.openContract({
      userId: input.userId, stakeCents: input.stakeCents, direction: "buy", entryRate,
      durationS: 1, gameDayId: ctx.gameDayId, nonce, openedAtMs,
      configVersion: ctx.configVersion, siteId: ctx.siteId ?? null,
      kind: "digit", contract: { kind: input.kind, target, instrumentId, openIndex, settleIndex },
    });

    let decided: { result: "win" | "loss"; payoutCents: number; digit: number } | null = null;
    let poolReserved = false;
    if (poolPath && this.pool) {
      // Fixed-odds candidate payout: exactly what a win would cost (stake × factor / winProb).
      const candidate = digitReturnCents(input.stakeCents, input.kind, input.kind === "over" || input.kind === "under" ? target : 0, this.digitFactor());
      const po = await this.pool.controller.decideReserveFixed({
        siteId: ctx.siteId ?? "", userId: input.userId, stakeCents: input.stakeCents,
        payoutCents: candidate, positionId, nonce, openedAtMs, serverSeed: ctx.seed,
        balanceAfterStakeCents: newBalance, minWithdrawalCents: this.cfg.minWithdrawalEffectiveCents ?? this.cfg.minWithdrawalCents,
        // Central RTP dial, identical to the rise/fall pool path: targetRtp = 1 − house_edge.
        targetRtp: Math.min(0.95, Math.max(0.05, 1 - this.cfg.houseEdge)),
      });
      const digit = decisionDigit(ctx.seed, nonce, input.kind, target, po.result === "win");
      // digitsForOutcome is non-empty for every grantable decision (a p=0 contract can never win);
      // the fair feed digit is a defensive fallback only.
      decided = { result: po.result, payoutCents: po.result === "win" ? po.payoutCents : 0, digit: digit ?? feed.tickAt(settleIndex).digit };
      poolReserved = true;
    } else if (isMarketer) {
      // DEMO/MARKETER (pool-exempt, FAKE money): the win FREQUENCY follows the enforced cohort win-rate
      // — the SAME strategy the rise/fall line-graph uses via settleVariable — never the contract's raw
      // odds. Decided seed-deterministically so a crash recovers identically; pays the contract's fixed
      // odds on a win. The pool path (real players) never reaches here; nothing below reserves/commits
      // the real-cash pool. A non-marketer with the pool OFF keeps the provably-fair digit (below).
      const ov = this.loadOverride ? await this.loadOverride(input.userId) : null;
      const winRate = ov?.winRate ?? this.cfg.targetWinRate;
      const st = decideDigitAtWinRate(ctx.seed, nonce, input.kind, target, winRate, input.stakeCents, this.digitFactor());
      decided = { result: st.won ? "win" : "loss", payoutCents: st.payoutCents, digit: st.digit };
    }

    this.digitContracts.set(positionId, { userId: input.userId, stakeCents: input.stakeCents, kind: input.kind, target, instrumentId, openIndex, settleIndex, openedAtMs, siteId: ctx.siteId ?? null, decided, poolReserved });
    return { positionId, balance: newBalance, entryRate, instrumentId, openIndex, settleIndex, poolControlled: decided !== null };
  }

  /**
   * Settle an open DIGIT contract. Pool-decided contracts settle to their reserved decision (digit
   * drawn from the decision seed, pool committed on a win, session advanced); statistical contracts
   * settle against the committed `settleIndex` fair digit. Deterministic either way — the result is
   * identical whether settled live or on recovery. Idempotent via the repo.
   */
  async settleDigitContract(positionId: string): Promise<{ positionId: string; digit: number; won: boolean; payoutCents: number; pnlCents: number; balance: number }> {
    const c = this.digitContracts.get(positionId);
    if (!c) throw new Error("CONTRACT_NOT_FOUND");
    const ctx = this.getActiveContext();
    if (!ctx.seed) throw new Error("NO_SEED");
    const feed = this.feedFor(ctx.seed, c.instrumentId);
    const fairTick = feed.tickAt(c.settleIndex);

    if (c.decided) {
      // ── Pool path: settle EXACTLY the controller's decision (never recomputed). ──
      const won = c.decided.result === "win";
      const digit = c.decided.digit;
      const exitRate = withLastPip(fairTick.quote, digit);
      const { newBalance } = await this.repo.settlePosition({
        positionId, exitRate, result: won ? "win" : "loss", multiplier: 0, payoutCents: c.decided.payoutCents,
      });
      this.digitContracts.delete(positionId);
      // Pool session/commit ONLY for a pool-reserved (real-money) decision. A statistical marketer/demo
      // decision is pool-exempt — it must never touch the real-cash pool.
      if (c.poolReserved && this.pool) {
        this.pool.controller.settleSession(c.userId, poolEatDay(c.openedAtMs), won ? "win" : "loss", c.decided.payoutCents);
        if (won) {
          try { await this.pool.controller.commit(positionId); }
          catch (err) { this.emitError(err as Error, `pool commit ${positionId}`); }
        }
      }
      return { positionId, digit, won, payoutCents: c.decided.payoutCents, pnlCents: c.decided.payoutCents - c.stakeCents, balance: newBalance };
    }

    // ── Statistical path (pool off / marketers): provably-fair uniform digit. ──
    const st = settleDigit(c.stakeCents, c.kind, c.target, fairTick.digit, this.digitFactor());
    const { newBalance } = await this.repo.settlePosition({
      positionId, exitRate: fairTick.quote, result: st.won ? "win" : "loss", multiplier: 0, payoutCents: st.payoutCents,
    });
    this.digitContracts.delete(positionId);
    return { positionId, digit: fairTick.digit, won: st.won, payoutCents: st.payoutCents, pnlCents: st.pnlCents, balance: newBalance };
  }

  /** Instrument ids that currently have at least one open digit contract (for stream fan-out). */
  openDigitInstruments(): Set<string> {
    const s = new Set<string>();
    for (const c of this.digitContracts.values()) s.add(c.instrumentId);
    return s;
  }

  /**
   * Settle every open digit contract on `instrumentId` whose `settleIndex` has been reached
   * (`currentIndex >= settleIndex`). The transport calls this on each authoritative instrument tick.
   * Returns the settled results (with owning userId) for per-user fan-out.
   */
  async settleDueDigits(instrumentId: string, currentIndex: number): Promise<Array<{ positionId: string; userId: string; digit: number; won: boolean; payoutCents: number; pnlCents: number; balance: number }>> {
    const due: string[] = [];
    for (const [id, c] of this.digitContracts) if (c.instrumentId === instrumentId && currentIndex >= c.settleIndex) due.push(id);
    const out: Array<{ positionId: string; userId: string; digit: number; won: boolean; payoutCents: number; pnlCents: number; balance: number }> = [];
    for (const id of due) {
      const c = this.digitContracts.get(id);
      if (!c) continue;
      try {
        const r = await this.settleDigitContract(id);
        out.push({ ...r, userId: c.userId });
      } catch (err) { this.emitError(err as Error, `settle-digit ${id}`); }
    }
    return out;
  }

  /**
   * Open a Deriv-style MULTIPLIER contract (Phase 2), now on the PER-INSTRUMENT feed and governed
   * exactly like digits/rise-fall (docs/25):
   *  - POOL PATH (brand pool_mode ON + non-marketer): a timed bracket contract. Take Profit is the
   *    contract's fixed upside (default +100% of stake); the pool decides win/loss AT OPEN via
   *    decideReserveFixed (candidate payout = stake + TP) and reserves it. The live P/L renders the
   *    seeded reversing path to the decided endpoint over a seeded 20–60s window, then auto-settles:
   *    WIN closes at exactly +TP (commit), LOSS stops out at −stake. Stop Loss / Deal Cancellation /
   *    manual close are unavailable in pool mode (decision B — a player must never cash the green
   *    feint of a decided loss). Same central budget as digits + rise/fall.
   *  - STATISTICAL PATH (pool off, or marketers/demo): honest path-dependent P/L on the authoritative
   *    instrument quote: ±(move%) × multiplier × stake, floored at −stake; optional TP/SL, optional
   *    Deal Cancellation (SL disabled while DC is active, per Deriv); manual close any time.
   * Stake/position/ledger persist atomically (fn_open_contract); settlement reuses fn_settle_position.
   * One open multiplier per (user, instrument).
   */
  async openMultiplierContract(input: {
    userId: string; stakeCents: number; dir: MultDir; multiplier: number;
    tpCents?: number | null | undefined; slCents?: number | null | undefined; dcMinutes?: number | undefined;
    instrumentId?: string | undefined; role?: string | undefined;
  }): Promise<{ positionId: string; balance: number; entry: number; instrumentId: string; poolControlled: boolean; tpCents: number | null; slCents: number | null; dcUntilMs: number | null; dcFeeCents: number }> {
    if (!Number.isInteger(input.stakeCents)) throw new RangeError("stake must be integer cents");
    if (input.stakeCents < this.cfg.minStakeCents) throw new Error(`STAKE_BELOW_MIN: min ${this.cfg.minStakeCents}`);
    if (input.stakeCents > this.cfg.maxStakeCents) throw new Error(`STAKE_ABOVE_MAX: max ${this.cfg.maxStakeCents}`);
    if (!(input.multiplier > 0)) throw new Error("INVALID_MULTIPLIER");
    if (input.dir !== "up" && input.dir !== "down") throw new Error("INVALID_DIRECTION");
    const instrumentId = input.instrumentId ?? DEFAULT_INSTRUMENT_ID;
    if (!isKnownInstrument(instrumentId)) throw new Error("INVALID_INSTRUMENT");
    for (const c of this.multiplierContracts.values()) {
      if (c.userId === input.userId && c.instrumentId === instrumentId) throw new Error("CONTRACT_EXISTS: one open multiplier per instrument");
    }
    const ctx = this.getActiveContext();
    if (!ctx.seed) throw new Error("NO_SEED");
    const feed = this.feedFor(ctx.seed, instrumentId);
    const openedAtMs = this.now();
    const openIndex = feed.indexAt(openedAtMs, ctx.dayStartMs);
    const entry = feed.tickAt(openIndex).quote;
    const nonce = (nonceCounter = (nonceCounter + 1) % Number.MAX_SAFE_INTEGER);

    const isMarketer = this.loadIsMarketer ? await this.loadIsMarketer(input.userId) : (input.role === "marketer");
    const poolPath = (this.pool?.enabled() ?? false) && !isMarketer;
    // A demo/marketer multiplier is decided at the cohort win-rate (the SAME strategy the rise/fall
    // line-graph uses), rendered along the same seeded path the pool uses — so it needs the pool object
    // (for `controller.live`) and the day seed. isMarketer ⇒ !poolPath, so this is the marketer branch.
    // FAKE money only; it never reserves or commits the real-cash pool.
    const marketerDecideMult = isMarketer && !!this.pool && !!ctx.seed;
    // A DECIDED contract (pool OR marketer) runs to its endpoint: fixed TP upside, no SL/DC/manual close.
    const decidedMult = poolPath || marketerDecideMult;

    // Pool/decided mode: TP is the contract's fixed upside (default +100%); SL/DC are unavailable.
    const dcMinutes = decidedMult ? 0 : Math.max(0, Math.trunc(input.dcMinutes ?? 0));
    const dcUntilMs = dcMinutes > 0 ? openedAtMs + dcMinutes * 60_000 : null;
    const dcFeeCents = dealCancellationFeeCents(input.stakeCents, dcMinutes);
    // Deriv: Stop Loss is unavailable while Deal Cancellation is active.
    const slCents = decidedMult ? null : (dcUntilMs != null ? null : (input.slCents ?? null));
    const tpCents = decidedMult
      ? Math.max(1, Math.trunc(input.tpCents ?? input.stakeCents))
      : (input.tpCents ?? null);

    const state: MultiplierState = {
      dir: input.dir, entry, multiplier: input.multiplier, stakeCents: input.stakeCents,
      tpCents, slCents, dcUntilMs, dcFeeCents,
    };
    const { positionId, newBalance } = await this.repo.openContract({
      userId: input.userId, stakeCents: input.stakeCents, direction: input.dir === "up" ? "buy" : "sell",
      entryRate: entry, durationS: 1, gameDayId: ctx.gameDayId, nonce, openedAtMs,
      configVersion: ctx.configVersion, siteId: ctx.siteId ?? null,
      kind: "multiplier",
      contract: { dir: input.dir, multiplier: input.multiplier, tpCents, slCents, dcUntilMs, dcFeeCents, instrumentId, openIndex },
    });

    let decided: { result: "win" | "loss"; payoutCents: number; durationMs: number } | null = null;
    let poolReserved = false;
    if (poolPath && this.pool) {
      const candidate = input.stakeCents + (tpCents as number); // fixed upside: stake back + TP
      const po = await this.pool.controller.decideReserveFixed({
        siteId: ctx.siteId ?? "", userId: input.userId, stakeCents: input.stakeCents,
        payoutCents: candidate, positionId, nonce, openedAtMs, serverSeed: ctx.seed,
        balanceAfterStakeCents: newBalance, minWithdrawalCents: this.cfg.minWithdrawalEffectiveCents ?? this.cfg.minWithdrawalCents,
        targetRtp: Math.min(0.95, Math.max(0.05, 1 - this.cfg.houseEdge)),
      });
      decided = { result: po.result, payoutCents: po.result === "win" ? po.payoutCents : 0, durationMs: poolMultiplierDurationMs(ctx.seed, nonce) };
      poolReserved = true;
    } else if (marketerDecideMult) {
      // STATISTICAL (demo/marketer): win at the enforced cohort win-rate, seed-deterministic so a crash
      // recovers identically. Pays the same fixed upside (stake + TP) the pool path pays, WITHOUT any
      // pool reservation. Rendered live along the pool's seeded path (settleMultiplierDecided is gated
      // so the settle never touches the real-cash pool).
      const ov = this.loadOverride ? await this.loadOverride(input.userId) : null;
      const winRate = ov?.winRate ?? this.cfg.targetWinRate;
      const won = seededWin(ctx.seed, nonce, winRate);
      decided = { result: won ? "win" : "loss", payoutCents: won ? input.stakeCents + (tpCents as number) : 0, durationMs: poolMultiplierDurationMs(ctx.seed, nonce) };
    }

    this.multiplierContracts.set(positionId, {
      userId: input.userId, siteId: ctx.siteId ?? null, stakeCents: input.stakeCents,
      instrumentId, openedAtMs, nonce, state, decided, poolReserved,
    });
    return { positionId, balance: newBalance, entry, instrumentId, poolControlled: decided !== null, tpCents, slCents, dcUntilMs, dcFeeCents };
  }

  /** Live P/L for an open multiplier (server-authoritative), or null if it isn't open here. */
  liveMultiplierPnl(positionId: string): number | null {
    const c = this.multiplierContracts.get(positionId);
    if (!c) return null;
    const ctx = this.getActiveContext();
    if (!ctx.seed) return null;
    if (c.decided) {
      const g = Math.min(1, Math.max(0, (this.now() - c.openedAtMs) / c.decided.durationMs));
      const path = this.pool!.controller.live(
        { result: c.decided.result, multiplier: c.decided.result === "win" ? c.decided.payoutCents / c.stakeCents : 0, payoutCents: c.decided.payoutCents },
        ctx.seed, c.nonce, g);
      return Math.round(c.stakeCents * (path - 1));
    }
    const feed = this.feedFor(ctx.seed, c.instrumentId);
    return multiplierPnlCents(c.state, feed.tickAt(feed.indexAt(this.now(), ctx.dayStartMs)).quote);
  }

  /** Instrument ids that currently have at least one open multiplier (for stream fan-out/boot). */
  openMultiplierInstruments(): Set<string> {
    const s = new Set<string>();
    for (const c of this.multiplierContracts.values()) s.add(c.instrumentId);
    return s;
  }

  /**
   * Advance every open multiplier on `instrumentId` for the authoritative tick at `index`: emit live
   * P/L updates and auto-close whatever is due — pool contracts at their decided endpoint (WIN pays
   * exactly stake+TP and commits the reservation; LOSS stops out at −stake), statistical contracts on
   * TP / SL / stop-out / deal-cancellation. The transport calls this on each instrument tick.
   */
  async tickMultipliers(instrumentId: string, index: number): Promise<{
    updates: Array<{ positionId: string; userId: string; pnlCents: number }>;
    closed: Array<{ positionId: string; userId: string; reason: MultCloseReason; pnlCents: number; payoutCents: number; balance: number }>;
  }> {
    const updates: Array<{ positionId: string; userId: string; pnlCents: number }> = [];
    const closed: Array<{ positionId: string; userId: string; reason: MultCloseReason; pnlCents: number; payoutCents: number; balance: number }> = [];
    const ctx = this.getActiveContext();
    if (!ctx.seed) return { updates, closed };
    const feed = this.feedFor(ctx.seed, instrumentId);
    const nowMs = this.now();
    for (const [id, c] of [...this.multiplierContracts]) {
      if (c.instrumentId !== instrumentId) continue;
      try {
        if (c.decided) {
          const g = (nowMs - c.openedAtMs) / c.decided.durationMs;
          if (g >= 1) {
            const won = c.decided.result === "win";
            const r = await this.settleMultiplierDecided(id, c, feed.tickAt(index).quote);
            closed.push({ positionId: id, userId: c.userId, reason: won ? "tp" : "stopout", pnlCents: r.pnlCents, payoutCents: r.payoutCents, balance: r.balance });
          } else {
            const path = this.pool!.controller.live(
              { result: c.decided.result, multiplier: c.decided.result === "win" ? c.decided.payoutCents / c.stakeCents : 0, payoutCents: c.decided.payoutCents },
              ctx.seed, c.nonce, Math.max(0, g));
            updates.push({ positionId: id, userId: c.userId, pnlCents: Math.round(c.stakeCents * (path - 1)) });
          }
          continue;
        }
        const cur = feed.tickAt(index).quote;
        const e = evaluateMultiplier(c.state, cur, nowMs);
        if (e.close) {
          const r = await this.settleMultiplier(id, c.state, cur, e.realizedCents, e.reason ?? "manual");
          closed.push({ positionId: id, userId: c.userId, reason: r.reason, pnlCents: r.pnlCents, payoutCents: r.payoutCents, balance: r.balance });
        } else {
          updates.push({ positionId: id, userId: c.userId, pnlCents: e.pnlCents });
        }
      } catch (err) { this.emitError(err as Error, `tick-multiplier ${id}`); }
    }
    return { updates, closed };
  }

  /**
   * Manually close (cash out) an open STATISTICAL multiplier at the current authoritative quote.
   * Pool-decided multipliers cannot be closed manually (docs/25 decision B): they run to their
   * decided endpoint, so a player can never cash the green feint of a decided loss.
   */
  async closeMultiplierContract(positionId: string, userId?: string): Promise<{ positionId: string; closed: boolean; reason: MultCloseReason | null; pnlCents: number; payoutCents: number; balance: number | null }> {
    const c = this.multiplierContracts.get(positionId);
    if (!c || (userId !== undefined && c.userId !== userId)) throw new Error("CONTRACT_NOT_FOUND");
    if (c.decided) throw new Error("CLOSE_DISABLED: manual close is disabled in pool mode");
    const ctx = this.getActiveContext();
    if (!ctx.seed) throw new Error("NO_SEED");
    const feed = this.feedFor(ctx.seed, c.instrumentId);
    const cur = feed.tickAt(feed.indexAt(this.now(), ctx.dayStartMs)).quote;
    const realized = multiplierPnlCents(c.state, cur); // already floored at −stake
    return this.settleMultiplier(positionId, c.state, cur, realized, "manual");
  }

  /** Settle a DECIDED multiplier at its endpoint: exactly the decision. Pool session/commit run ONLY
   *  for a pool-reserved (real-money) decision — a statistical marketer/demo decision is pool-exempt. */
  private async settleMultiplierDecided(
    positionId: string, c: { userId: string; stakeCents: number; openedAtMs: number; poolReserved: boolean; decided: { result: "win" | "loss"; payoutCents: number } | null }, exitRate: number,
  ): Promise<{ pnlCents: number; payoutCents: number; balance: number }> {
    const won = c.decided!.result === "win";
    const payoutCents = won ? c.decided!.payoutCents : 0;
    const { newBalance } = await this.repo.settlePosition({
      positionId, exitRate, result: won ? "win" : "loss",
      multiplier: won ? payoutCents / c.stakeCents : 0, payoutCents,
    });
    this.multiplierContracts.delete(positionId);
    if (c.poolReserved && this.pool) {
      this.pool.controller.settleSession(c.userId, poolEatDay(c.openedAtMs), won ? "win" : "loss", payoutCents);
      if (won) {
        try { await this.pool.controller.commit(positionId); }
        catch (err) { this.emitError(err as Error, `pool commit ${positionId}`); }
      }
    }
    return { pnlCents: payoutCents - c.stakeCents, payoutCents, balance: newBalance };
  }

  private async settleMultiplier(
    positionId: string, s: MultiplierState, cur: number, realizedCents: number, reason: MultCloseReason,
  ): Promise<{ positionId: string; closed: boolean; reason: MultCloseReason; pnlCents: number; payoutCents: number; balance: number }> {
    const realized = Math.max(-s.stakeCents, realizedCents);
    const payoutCents = Math.max(0, s.stakeCents + realized); // stake returned + P/L (0 on stop-out)
    const result: "win" | "loss" = realized > 0 ? "win" : "loss";
    const { newBalance } = await this.repo.settlePosition({ positionId, exitRate: cur, result, multiplier: s.multiplier, payoutCents });
    this.multiplierContracts.delete(positionId);
    return { positionId, closed: true, reason, pnlCents: realized, payoutCents, balance: newBalance };
  }

  /**
   * Re-arm an in-flight multiplier recovered from the database after a restart (idempotent). The
   * caller (RecoveryService) rebuilt its state from `positions.contract` (+ the persisted pool
   * decision when one exists); it then resumes normal tick-driven evaluation / its decided path.
   */
  rearmMultiplier(positionId: string, c: {
    userId: string; siteId: string | null; stakeCents: number; instrumentId: string; openedAtMs: number;
    nonce: number; state: MultiplierState; decided: { result: "win" | "loss"; payoutCents: number; durationMs: number } | null;
    poolReserved: boolean;
  }): boolean {
    if (this.multiplierContracts.has(positionId)) return false;
    this.multiplierContracts.set(positionId, c);
    return true;
  }

  /**
   * Re-arm an in-flight position recovered from the database after a restart. The caller
   * (RecoveryService) has already recomputed its committed outcome from the day seed, so
   * the position resumes its normal lifecycle: live updates until expiry, then auto-settle.
   * Idempotent and safe — never re-arms an already-tracked or non-open position.
   */
  rearm(p: Position): boolean {
    if (p.status !== "open") return false;
    if (this.positions.has(p.id)) return false;
    this.positions.set(p.id, p);
    return true;
  }

  /** The elapsed seconds a continuous position is valued at right now, clamped to its horizon. */
  private elapsedS(p: Position): number {
    return Math.min(p.durationS, Math.max(0, (this.now() - p.openedAtMs) / 1000));
  }

  /**
   * Close a position because one of its protective levels was reached.
   *
   * It settles at what the continuous payout says the contract is worth AT THAT MOMENT, which is
   * the whole point: a stop that pays the committed outcome rather than the price it fired at is
   * not a stop. Because the payout is continuous, a stop is a PARTIAL loss and a target a real
   * profit, and neither can be the all-or-nothing jump the step payout forced.
   */
  private async closeAtLevel(p: Position, reason: "sl" | "tp"): Promise<SettledEvent> {
    const settlement = this.getActiveContext().settlement;
    return this.finalize(p, settlement.valueAt(p.direction, p.entryT, this.elapsedS(p)), "auto", reason);
  }

  /**
   * MetaTrader's Modify position: set, move or clear the protective levels.
   *
   * Server-side, because a level held only in the browser is decoration. A refreshed tab, a closed
   * laptop or a dead connection all leave the engine holding the stop, and it fires regardless.
   */
  setLevels(positionId: string, userId: string, slPrice: number | null, tpPrice: number | null): Position {
    const p = this.positions.get(positionId);
    if (!p || p.userId !== userId) throw new Error("POSITION_NOT_FOUND");
    if (p.status !== "open") throw new Error("ALREADY_SETTLED");
    if (!p.continuous) throw new Error("LEVELS_UNSUPPORTED: this contract settles at expiry");
    p.slPrice = Number.isFinite(slPrice as number) ? slPrice : null;
    p.tpPrice = Number.isFinite(tpPrice as number) ? tpPrice : null;
    this.persistLevels(p);
    return p;
  }

  /**
   * Write the levels to the position's row, so a restart does not lose them (migration 0183).
   *
   * FIRE-AND-FORGET, on the same terms as the display-price stamp in pricestamp.ts: it is issued
   * after the in-memory levels are already set, never awaited, and a failure is logged rather than
   * thrown. A level the trader can see is worth more than a level that refuses to be set because
   * the database hiccuped, and a missed write leaves exactly the behaviour this replaced.
   *
   * The repository method is optional, so the in-memory dev repository and every existing fake keep
   * working without it.
   */
  private persistLevels(p: Position): void {
    const write = this.repo.setPositionLevels?.bind(this.repo);
    if (!write) return;
    void write(p.id, p.slPrice, p.tpPrice).catch((err: unknown) => {
      // Not fatal: see the note above. Logged so a persistently failing write is visible.
      console.warn(`[levels] persisting ${p.id} failed:`, (err as Error)?.message ?? err);
    });
  }

  /**
   * Does this brand price positions continuously, so a protective level can fire?
   *
   * The same test `openPosition` makes. Crash recovery needs it to re-arm a position the way it was
   * opened rather than guessing, which is why it is exposed rather than inferred from the row.
   */
  get hasPriceAxis(): boolean {
    return this.priceAxis !== undefined;
  }

  async sell(positionId: string, userId: string): Promise<SettledEvent> {
    // docs/25 decision B: manual SELL is disabled brand-wide in pool mode (a player must not cash
    // the green peak of a trade the controller decided will lose). Pool trades auto-settle at expiry.
    if (this.pool?.enabled()) throw new Error("SELL_DISABLED: manual sell is disabled in pool mode");
    const p = this.positions.get(positionId);
    if (!p || p.userId !== userId) throw new Error("POSITION_NOT_FOUND");
    if (p.status !== "open") throw new Error("ALREADY_SETTLED");
    // A continuous contract has no committed outcome to protect, so there is nothing to refuse:
    // closing pays exactly what the price says it is worth, which is <= the stake on a loser. The
    // `sellable` guard below still governs the committed contract, where cashing a decided loser
    // early WOULD pay out a trade the engine had already priced as lost.
    if (p.continuous) {
      return this.finalize(p, this.getActiveContext().settlement.valueAt(p.direction, p.entryT, this.elapsedS(p)), "manual");
    }
    if (!p.sellable) throw new Error("NOT_SELLABLE: losing positions settle at expiry");
    const g = (this.now() - p.openedAtMs) / (p.durationS * 1000);
    return this.finalize(p, this.getActiveContext().settlement.liveWinMultiplier(p.outcome.multiplier, g), "manual");
  }

  private async settleAuto(p: Position): Promise<SettledEvent> {
    // A continuous contract has no committed endpoint: reaching the horizon is just another moment
    // to be valued at, the same as a stop or a target reached one tick earlier.
    if (p.continuous) {
      return this.finalize(p, this.getActiveContext().settlement.valueAt(p.direction, p.entryT, p.durationS), "auto", "horizon");
    }
    return this.finalize(p, p.outcome.result === "win" ? p.outcome.multiplier : 0, "auto");
  }

  /** Idempotent settlement. Status locked synchronously before the async repo call. */
  private async finalize(p: Position, multiplier: number, mode: "auto" | "manual", closedBy?: CloseReason): Promise<SettledEvent> {
    if (p.status !== "open") throw new Error("ALREADY_SETTLED");
    p.status = "settled";
    const payoutCents = multiplier >= 1 ? Math.round(p.stakeCents * multiplier) : 0;
    const result: "win" | "loss" = payoutCents > 0 ? "win" : "loss";
    try {
      const { newBalance } = await this.repo.settlePosition({ positionId: p.id, exitRate: p.outcome.exitRate, result, multiplier, payoutCents });
      // docs/25: update the player's engagement session (win -> returned/streak; loss -> streak) and
      // commit the pool reservation for a settled win. Budget stays protected even if commit defers.
      if (p.poolControlled && this.pool) {
        this.pool.controller.settleSession(p.userId, poolEatDay(p.openedAtMs), result, payoutCents);
        if (result === "win") {
          try { await this.pool.controller.commit(p.id); }
          catch (err) { this.emitError(err as Error, `pool commit ${p.id}`); }
        }
      }
      const tau = this.getActiveContext().settlement.params[p.direction].tau;
      const presentation = presentOutcome({ result, multiplier, signedMove: p.outcome.signedMove, tau });
      const e: SettledEvent = {
        position: p, lockedMultiplier: multiplier, payoutCents, pnlCents: payoutCents - p.stakeCents,
        balance: newBalance, mode, presentation,
        ...(closedBy ? { closedBy } : {}),
      };
      this.emitSettled(e);
      return e;
    } catch (err) { p.status = "open"; throw err; }
  }

  getPosition(id: string): Position | undefined { return this.positions.get(id); }
  openCount(): number { let n = 0; for (const p of this.positions.values()) if (p.status === "open") n++; return n; }
  /**
   * This user's still-running contracts, so a client that reconnected can be told about them.
   *
   * A refreshed browser knew nothing about a contract it had opened before the reload: the client
   * holds `activePosition` in React state, and the engine had no way to be asked. Its tick updates
   * were already arriving at the new socket (fan-out is keyed by site and user, resolved at emit
   * time) and were being dropped for want of a position to attach them to.
   *
   * A scan rather than a per-user index, deliberately: an index is a second copy of the truth that
   * has to be kept in step with every open, settle and recovery path, and this map holds the
   * OPEN contracts of one brand, which is a handful. Read-only, and it decides nothing.
   */
  openPositionsOf(userId: string): Position[] {
    const out: Position[] = [];
    for (const p of this.positions.values()) if (p.status === "open" && p.userId === userId) out.push(p);
    return out;
  }
  onlineConfigSnapshot() {
    const c = this.cfg;
    return {
      minStakeCents: c.minStakeCents, maxStakeCents: c.maxStakeCents, maxMultiplier: c.maxMultiplier,
      defaultDurationS: c.defaultDurationS, tickRateMs: c.tickRateMs,
      configVersion: (c as VersionedGameConfig).version ?? 0,
      // Whether `sell` can succeed at all on this brand. Pool mode refuses every manual close
      // (decision B above), and the client had no way to know: it drew a Close button, and every
      // tap came back SELL_DISABLED. This reports the rule rather than changing it. Nothing about
      // how a position is decided or settled is touched; it is the same boolean `sell` already
      // tests, said out loud so the interface can be honest.
      earlyCloseEnabled: !(this.pool?.enabled() ?? false),
      /**
       * The SPREAD this brand charges, per side, in curve-value units.
       *
       * Not a new cost and not a display invention. `cost` is what the continuous payout is built
       * on: `clamp(1 + gain * (move - cost), maxMultiplier)`, so a position is worth exactly its
       * stake when `move == cost` and the trader keeps only what they make beyond it. settle.ts
       * says it in those words: "`cost` is economically the SPREAD: the move a trader must make to
       * break even, and the whole edge lives there."
       *
       * So the brand has always quoted a spread; it simply never showed one, and the order ticket
       * printed a single price with the note that there was no spread for two to sit either side
       * of. That note was true under the step economy and stopped being true when the terminal's
       * edge moved into the spread. Published per DIRECTION because the calibration solves one
       * cost per side, and they need not be equal.
       *
       * In value units, so the client converts with the same `scale` it already uses to turn a
       * curve value into a price. Null on a brand with no price axis: there the committed step
       * contract is in force, nothing is priced continuously, and there is no spread to state.
       */
      spread: this.hasPriceAxis ? this.spreadSnapshot() : null,
    };
  }

  /**
   * The break-even cost per side, read off the ACTIVE day's settlement.
   *
   * Read rather than stored: the calibration is per day and per config version, so a brand that
   * reseeds at midnight or has its economics changed by an operator quotes the new spread straight
   * away, exactly as it settles on it.
   */
  private spreadSnapshot(): { buy: number; sell: number } | null {
    try {
      const s = this.getActiveContext().settlement;
      return { buy: s.continuousParams("buy").cost, sell: s.continuousParams("sell").cost };
    } catch {
      // A brand whose day context is not built yet quotes no spread rather than a guessed one.
      return null;
    }
  }
}
