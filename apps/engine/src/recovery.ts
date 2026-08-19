import { dateKeyUTC } from "@invest254/shared";
import type { GameRepository } from "./wallet.js";
import type { SeedManager } from "./daycontext.js";
import type { GameServer, Position, LoadOverride } from "./game.js";
import { overrideAffectsPricing, userSettlement } from "./overrides.js";
import type { PoolController } from "./poolcontroller.js";

export interface RecoveryReport {
  scanned: number;   // open positions found in the DB
  settled: number;   // already expired -> finalised now
  rearmed: number;   // still in-flight -> resumed on the server
  noop: number;      // settle returned idempotent false (already settled by a racing process)
  failed: number;    // could not be processed (logged)
}

/**
 * Crash recovery. On boot, every position the DB still considers `open` is replayed
 * deterministically:
 *
 *   1. derive the position's day from its persisted opened_at (UTC),
 *   2. recompute its committed outcome from that day's seed (no secret read — recomputed),
 *   3. if expiry has passed, settle it now (idempotent in the DB); otherwise re-arm it on
 *      the GameServer so it resumes live and auto-settles at expiry.
 *
 * Because outcomes are pure functions of (masterSeed, dateKey, configVersion, entryT,
 * direction), the recovered settlement is identical to what would have happened with no
 * crash -- provided we replay under the SAME configuration. That is why step 2 passes the
 * position's stored `config_version` rather than the config that happens to be live now:
 * an admin edit made while the position was in flight must never re-price it.
 */
export class RecoveryService {
  constructor(
    private readonly repo: GameRepository,
    private readonly seeds: SeedManager,
    private readonly game: GameServer,
    private readonly now: () => number = () => Date.now(),
    /** Same per-user override provider the GameServer opens with, so an override position reprices
     *  identically after a crash (see overrides.ts for the mid-flight-change caveat). */
    private readonly loadOverride?: LoadOverride,
    /** Multi-tenant: recover only this brand's open positions (undefined = all, single-tenant). */
    private readonly siteId?: string,
    /** docs/25: pool controller — a position with a stored decision is recovered from THAT decision
     *  (not recomputed from the curve), and its reservation is committed on a recovered win. */
    private readonly pool?: PoolController,
  ) {}

  async recover(): Promise<RecoveryReport> {
    const all = await this.repo.listOpenPositions();
    const open = this.siteId === undefined ? all : all.filter((r) => (r.siteId ?? null) === this.siteId);
    const report: RecoveryReport = { scanned: open.length, settled: 0, rearmed: 0, noop: 0, failed: 0 };
    const nowMs = this.now();

    for (const row of open) {
      try {
        const dateKey = dateKeyUTC(row.openedAtMs);
        const ctx = await this.seeds.contextFor(dateKey, row.configVersion);
        const entryT = (row.openedAtMs - ctx.dayStartMs) / 1000;
        const expiresAtMs = row.openedAtMs + row.durationS * 1000;

        // ── Pool position (docs/25): recover from the STORED decision, never recomputed from the
        //    curve. On a recovered win, commit the reservation (reserved -> paid); the budget was
        //    already protected by the reservation, so a commit hiccup can never overspend. ──
        const decision = this.pool ? await this.pool.getDecision(row.id) : null;
        if (decision) {
          const entryRate = ctx.curve.rate(entryT);
          const exitRate = ctx.curve.rate(entryT + row.durationS);
          const multiplier = decision.result === "win" ? decision.multiplier : 0;
          const payoutCents = decision.result === "win" ? decision.payoutCents : 0;
          const outcome = { result: decision.result, multiplier, payoutCents, pnlCents: payoutCents - row.stakeCents, entryRate, exitRate, signedMove: 0 };
          if (nowMs >= expiresAtMs) {
            const res = await this.repo.settlePosition({ positionId: row.id, exitRate, result: decision.result, multiplier, payoutCents });
            if (res.settled) {
              report.settled++;
              if (decision.result === "win" && this.pool) { try { await this.pool.commit(row.id); } catch { /* reservation keeps the budget protected */ } }
            } else report.noop++;
          } else {
            const p: Position = {
              id: row.id, userId: row.userId, stakeCents: row.stakeCents, direction: row.direction,
              durationS: row.durationS, openedAtMs: row.openedAtMs, expiresAtMs, entryT, outcome,
              status: "open", sellable: false, gameDayId: row.gameDayId, configVersion: ctx.configVersion,
              nonce: decision.nonce ?? row.nonce, poolControlled: true,
            };
            if (this.game.rearm(p)) report.rearmed++; else report.noop++;
          }
          continue;
        }

        // ── Statistical position (unchanged): recompute from the day seed + stored config version ──
        // Reprice an override position with its per-user settlement (falls back to global if the
        // override is absent or infeasible), exactly matching how it was priced at open.
        const ov = this.loadOverride ? await this.loadOverride(row.userId) : null;
        const settlement = overrideAffectsPricing(ov)
          ? (userSettlement(ctx.curve, ctx.cfg, ov!) ?? ctx.settlement)
          : ctx.settlement;
        // Reproduce the EXACT outcome committed at open: the GameServer opens with
        // settleVariable(stake, dir, entryT, nonce, seed) whenever a day seed exists, so recovery
        // MUST use the same seeded engagement draw (not settle(), whose curve-derived multiplier
        // differs per position). Falls back to settle() only in the no-seed (local dev) path.
        const outcome = ctx.seed
          ? settlement.settleVariable(row.stakeCents, row.direction, entryT, row.nonce, ctx.seed)
          : settlement.settle(row.stakeCents, row.direction, entryT);

        if (nowMs >= expiresAtMs) {
          // Hold-to-expiry final outcome (no early sell can be inferred post-crash).
          const multiplier = outcome.result === "win" ? outcome.multiplier : 0;
          const payoutCents = multiplier >= 1 ? Math.round(row.stakeCents * multiplier) : 0;
          const result: "win" | "loss" = payoutCents > 0 ? "win" : "loss";
          const res = await this.repo.settlePosition({ positionId: row.id, exitRate: outcome.exitRate, result, multiplier, payoutCents });
          if (res.settled) report.settled++; else report.noop++;
        } else {
          const p: Position = {
            id: row.id, userId: row.userId, stakeCents: row.stakeCents, direction: row.direction,
            durationS: row.durationS, openedAtMs: row.openedAtMs, expiresAtMs, entryT, outcome,
            status: "open", sellable: outcome.result === "win", gameDayId: row.gameDayId,
            configVersion: ctx.configVersion,
            nonce: row.nonce, poolControlled: false,
          };
          if (this.game.rearm(p)) report.rearmed++; else report.noop++;
        }
      } catch {
        report.failed++;
      }
    }
    return report;
  }
}
