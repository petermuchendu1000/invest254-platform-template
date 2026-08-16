import {
  CurveGenerator, SettlementEngine, type GameConfig, type VersionedGameConfig,
  type Direction, type Outcome, type Tick, presentOutcome, type OutcomePresentation,
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

export class GameServer {
  private positions = new Map<string, Position>();
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
    const isMarketer = input.role === "marketer";
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
        balanceAfterStakeCents: newBalance, minWithdrawalCents: this.cfg.minWithdrawalCents,
        // Pool RTP is driven by the operator's house edge (unified config): targetSessionRtp = 1 - edge.
        targetRtp: Math.min(0.95, Math.max(0.05, 1 - this.cfg.houseEdge)),
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
