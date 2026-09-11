import {
  CurveGenerator, SettlementEngine, type GameConfig, type VersionedGameConfig,
  type Direction, type Outcome, type Tick, presentOutcome, type OutcomePresentation,
  settleDigit, type DigitKind,
  InstrumentFeed, instrumentById, isKnownInstrument, DEFAULT_INSTRUMENT_ID, digitPayoutFactor,
  digitReturnCents, decisionDigit, withLastPip, poolMultiplierDurationMs,
  multiplierPnlCents, evaluateMultiplier, dealCancellationFeeCents,
  type MultiplierState, type MultDir, type MultCloseReason,
} from "@invest254/shared";
import type { GameRepository } from "./wallet.js";
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
}
export interface SettledEvent { position: Position; lockedMultiplier: number; payoutCents: number; pnlCents: number; balance: number; mode: "auto" | "manual"; presentation: OutcomePresentation; }
export interface UpdateEvent { positionId: string; liveMultiplier: number; livePnlCents: number; secondsLeft: number; sellable: boolean; }
type Listener = { onTick?: (t: Tick) => void; onUpdate?: (u: UpdateEvent) => void; onSettled?: (e: SettledEvent) => void; onError?: (err: Error, ctx: string) => void; };

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
  private digitContracts = new Map<string, { userId: string; stakeCents: number; kind: DigitKind; target: number; instrumentId: string; openIndex: number; settleIndex: number; openedAtMs: number; siteId: string | null; decided: { result: "win" | "loss"; payoutCents: number; digit: number } | null }>();
  /** Per-(daySeed, instrument) authoritative feed cache; feeds are pure/deterministic and cheap. */
  private feeds = new Map<string, InstrumentFeed>();
  /** Phase 2: open (running) multiplier contracts — statistical (feed-evaluated) or pool-decided. */
  private multiplierContracts = new Map<string, { userId: string; siteId: string | null; stakeCents: number; instrumentId: string; openedAtMs: number; nonce: number; state: MultiplierState; decided: { result: "win" | "loss"; payoutCents: number; durationMs: number } | null }>();
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
  ) {}

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
      for (const p of this.positions.values()) {
        if (p.status !== "open") continue;
        if (nowMs >= p.expiresAtMs) { expired.push(p); continue; }
        const g = (nowMs - p.openedAtMs) / (p.durationS * 1000);
        const live = this.liveMultiplier(p, g, ctx.settlement);
        this.emitUpdate({ positionId: p.id, liveMultiplier: live, livePnlCents: Math.round(p.stakeCents * live) - p.stakeCents, secondsLeft: Math.max(0, (p.expiresAtMs - nowMs) / 1000), sellable: p.sellable });
      }
      for (const p of expired) { try { await this.settleAuto(p); } catch (err) { this.emitError(err as Error, `auto-settle ${p.id}`); } }
    } finally { this.stepping = false; }
  }

  private liveMultiplier(p: Position, g: number, settlement: SettlementEngine): number {
    if (p.poolControlled && this.pool) {
      const ctx = this.getActiveContext();
      // Seeded reversing path to the decided endpoint (green->red on a loss, red->green on a win).
      return this.pool.controller.live(
        { result: p.outcome.result, multiplier: p.outcome.multiplier, payoutCents: p.outcome.payoutCents },
        ctx.seed ?? "", p.nonce, g);
    }
    if (p.outcome.result === "win") return settlement.liveWinMultiplier(p.outcome.multiplier, g);
    const x = Math.min(1, Math.max(0, g));
    return 1 - x * x * x * (x * (x * 6 - 15) + 10);
  }

  /** Open a position: outcome committed in memory; stake+position+ledger persisted atomically by the repo. */
  async openPosition(input: { userId: string; stakeCents: number; direction: Direction; durationS?: number; role?: string }): Promise<{ position: Position; balance: number }> {
    // docs/25: when the brand is in pool mode, NON-marketer trades are governed by the pool
    // controller (not the curve) and admin overrides are IGNORED for them (decision E). Marketers
    // keep the statistical path WITH their overrides and are pool-exempt (decision F).
    // Canonical marketer classification (migration 0084): prefer the authoritative predicate so the
    // pool exemption matches the money layer's demo routing exactly; fall back to the role claim.
    const isMarketer = this.loadIsMarketer ? await this.loadIsMarketer(input.userId) : (input.role === "marketer");
    const poolActive = this.pool?.enabled() ?? false;
    const poolPath = poolActive && !isMarketer;
    const ov = (this.loadOverride && (!poolActive || isMarketer)) ? await this.loadOverride(input.userId) : null;
    const durationS = input.durationS ?? ov?.tradeDurationS ?? this.cfg.defaultDurationS;
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
      const { positionId, newBalance } = await this.repo.openPosition({
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
      };
      this.positions.set(positionId, p);
      return { position: p, balance: newBalance };
    }

    // ── Statistical path (pool off, or marketers) — unchanged behaviour ──
    const engine = this.settlementFor(ctx, ov);
    const outcome = ctx.seed
      ? engine.settleVariable(input.stakeCents, input.direction, entryT, nonce, ctx.seed)
      : engine.settle(input.stakeCents, input.direction, entryT);
    const { positionId, newBalance } = await this.repo.openPosition({
      userId: input.userId, stakeCents: input.stakeCents, direction: input.direction,
      entryRate: outcome.entryRate, durationS, gameDayId: ctx.gameDayId, nonce, openedAtMs,
      configVersion: ctx.configVersion, siteId: ctx.siteId ?? null,
    });
    const p: Position = { id: positionId, userId: input.userId, stakeCents: input.stakeCents, direction: input.direction, durationS, openedAtMs, expiresAtMs: openedAtMs + durationS * 1000, entryT, outcome, status: "open", sellable: outcome.result === "win", gameDayId: ctx.gameDayId, configVersion: ctx.configVersion, nonce, poolControlled: false };
    this.positions.set(positionId, p);
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
    }

    this.digitContracts.set(positionId, { userId: input.userId, stakeCents: input.stakeCents, kind: input.kind, target, instrumentId, openIndex, settleIndex, openedAtMs, siteId: ctx.siteId ?? null, decided });
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
      if (this.pool) {
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

    // Pool mode: TP is the contract's fixed upside (default +100%); SL/DC are unavailable.
    const dcMinutes = poolPath ? 0 : Math.max(0, Math.trunc(input.dcMinutes ?? 0));
    const dcUntilMs = dcMinutes > 0 ? openedAtMs + dcMinutes * 60_000 : null;
    const dcFeeCents = dealCancellationFeeCents(input.stakeCents, dcMinutes);
    // Deriv: Stop Loss is unavailable while Deal Cancellation is active.
    const slCents = poolPath ? null : (dcUntilMs != null ? null : (input.slCents ?? null));
    const tpCents = poolPath
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
    if (poolPath && this.pool) {
      const candidate = input.stakeCents + (tpCents as number); // fixed upside: stake back + TP
      const po = await this.pool.controller.decideReserveFixed({
        siteId: ctx.siteId ?? "", userId: input.userId, stakeCents: input.stakeCents,
        payoutCents: candidate, positionId, nonce, openedAtMs, serverSeed: ctx.seed,
        balanceAfterStakeCents: newBalance, minWithdrawalCents: this.cfg.minWithdrawalEffectiveCents ?? this.cfg.minWithdrawalCents,
        targetRtp: Math.min(0.95, Math.max(0.05, 1 - this.cfg.houseEdge)),
      });
      decided = { result: po.result, payoutCents: po.result === "win" ? po.payoutCents : 0, durationMs: poolMultiplierDurationMs(ctx.seed, nonce) };
    }

    this.multiplierContracts.set(positionId, {
      userId: input.userId, siteId: ctx.siteId ?? null, stakeCents: input.stakeCents,
      instrumentId, openedAtMs, nonce, state, decided,
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

  /** Settle a POOL-decided multiplier at its endpoint: exactly the decision, commit on win. */
  private async settleMultiplierDecided(
    positionId: string, c: { userId: string; stakeCents: number; openedAtMs: number; decided: { result: "win" | "loss"; payoutCents: number } | null }, exitRate: number,
  ): Promise<{ pnlCents: number; payoutCents: number; balance: number }> {
    const won = c.decided!.result === "win";
    const payoutCents = won ? c.decided!.payoutCents : 0;
    const { newBalance } = await this.repo.settlePosition({
      positionId, exitRate, result: won ? "win" : "loss",
      multiplier: won ? payoutCents / c.stakeCents : 0, payoutCents,
    });
    this.multiplierContracts.delete(positionId);
    if (this.pool) {
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

  async sell(positionId: string, userId: string): Promise<SettledEvent> {
    // docs/25 decision B: manual SELL is disabled brand-wide in pool mode (a player must not cash
    // the green peak of a trade the controller decided will lose). Pool trades auto-settle at expiry.
    if (this.pool?.enabled()) throw new Error("SELL_DISABLED: manual sell is disabled in pool mode");
    const p = this.positions.get(positionId);
    if (!p || p.userId !== userId) throw new Error("POSITION_NOT_FOUND");
    if (p.status !== "open") throw new Error("ALREADY_SETTLED");
    if (!p.sellable) throw new Error("NOT_SELLABLE: losing positions settle at expiry");
    const g = (this.now() - p.openedAtMs) / (p.durationS * 1000);
    return this.finalize(p, this.getActiveContext().settlement.liveWinMultiplier(p.outcome.multiplier, g), "manual");
  }

  private async settleAuto(p: Position): Promise<SettledEvent> {
    return this.finalize(p, p.outcome.result === "win" ? p.outcome.multiplier : 0, "auto");
  }

  /** Idempotent settlement. Status locked synchronously before the async repo call. */
  private async finalize(p: Position, multiplier: number, mode: "auto" | "manual"): Promise<SettledEvent> {
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
      const e: SettledEvent = { position: p, lockedMultiplier: multiplier, payoutCents, pnlCents: payoutCents - p.stakeCents, balance: newBalance, mode, presentation };
      this.emitSettled(e);
      return e;
    } catch (err) { p.status = "open"; throw err; }
  }

  getPosition(id: string): Position | undefined { return this.positions.get(id); }
  openCount(): number { let n = 0; for (const p of this.positions.values()) if (p.status === "open") n++; return n; }
  onlineConfigSnapshot() {
    const c = this.cfg;
    return {
      minStakeCents: c.minStakeCents, maxStakeCents: c.maxStakeCents, maxMultiplier: c.maxMultiplier,
      defaultDurationS: c.defaultDurationS, tickRateMs: c.tickRateMs,
      configVersion: (c as VersionedGameConfig).version ?? 0,
    };
  }
}
