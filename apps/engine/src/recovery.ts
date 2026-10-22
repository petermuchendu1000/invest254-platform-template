import {
  dateKeyUTC, settleDigit, type DigitKind, type MultDir,
  InstrumentFeed, instrumentById, DEFAULT_INSTRUMENT_ID, digitPayoutFactor,
  decisionDigit, withLastPip, poolMultiplierDurationMs,
  seededWin, decideDigitAtWinRate,
} from "@invest254/shared";
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
    /** Same marketer/demo predicate the GameServer opens with, so a demo/marketer deriv-ui contract —
     *  decided at the cohort win-rate, not persisted to the pool — is reconstructed identically. */
    private readonly loadIsMarketer?: (userId: string) => Promise<boolean>,
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

        // ── Phase 2 DIGIT contract: settle deterministically, never stranding a debited stake ─────
        // A POOL-decided digit settles from its persisted decision (position_decision — the same
        // source of truth as rise/fall pool recovery), with the display digit re-drawn from the
        // decision seed; a STATISTICAL digit recomputes the uniform fair digit from the committed
        // (instrument, settleIndex). Both are pure functions ⇒ recovery is idempotent + identical
        // to the no-crash path.
        if ((row.kind ?? "rise_fall") === "digit") {
          if (!ctx.seed) { report.failed++; continue; }
          const c = (row.contract ?? {}) as { kind?: DigitKind; target?: number; instrumentId?: string; settleIndex?: number };
          const feed = new InstrumentFeed(ctx.seed, instrumentById(c.instrumentId ?? DEFAULT_INSTRUMENT_ID));
          const tick = feed.tickAt(Number(c.settleIndex ?? 0));
          const decision = this.pool ? await this.pool.getDecision(row.id) : null;
          if (decision) {
            const won = decision.result === "win";
            const digit = decisionDigit(decision.seed, decision.nonce, c.kind ?? "even", c.target ?? 0, won) ?? tick.digit;
            const res = await this.repo.settlePosition({
              positionId: row.id, exitRate: withLastPip(tick.quote, digit),
              result: decision.result, multiplier: 0, payoutCents: won ? decision.payoutCents : 0,
            });
            if (res.settled) {
              report.settled++;
              if (won && this.pool) { try { await this.pool.commit(row.id); } catch { /* reservation keeps the budget protected */ } }
            } else report.noop++;
            continue;
          }
          // A DEMO/MARKETER digit was decided at the cohort win-rate; reconstruct the SAME decision
          // seed-deterministically (seed, nonce, winRate) so recovery is identical to no-crash. A
          // non-marketer with the pool OFF keeps the provably-fair uniform digit.
          const marketerDigit = this.loadIsMarketer ? await this.loadIsMarketer(row.userId) : false;
          if (marketerDigit) {
            const ov = this.loadOverride ? await this.loadOverride(row.userId) : null;
            const winRate = ov?.winRate ?? ctx.cfg.targetWinRate;
            const dst = decideDigitAtWinRate(ctx.seed, row.nonce, c.kind ?? "even", c.target ?? 0, winRate, row.stakeCents, digitPayoutFactor(ctx.cfg));
            const res = await this.repo.settlePosition({ positionId: row.id, exitRate: withLastPip(tick.quote, dst.digit), result: dst.won ? "win" : "loss", multiplier: 0, payoutCents: dst.payoutCents });
            if (res.settled) report.settled++; else report.noop++;
            continue;
          }
          const st = settleDigit(row.stakeCents, c.kind ?? "even", c.target ?? 0, tick.digit, digitPayoutFactor(ctx.cfg));
          const res = await this.repo.settlePosition({ positionId: row.id, exitRate: tick.quote, result: st.won ? "win" : "loss", multiplier: 0, payoutCents: st.payoutCents });
          if (res.settled) report.settled++; else report.noop++;
          continue;
        }
        // ── Phase 2 MULTIPLIER contract ───────────────────────────────────────────────────────────
        // Pool-decided: recover from the persisted decision — settle at its (seeded, recomputable)
        // endpoint if the window elapsed during the outage (+commit a win), else re-arm the decided
        // path. Statistical: re-arm from `positions.contract`; the next instrument tick re-evaluates
        // (and immediately closes anything already past TP/SL/stop-out). Idempotent.
        if ((row.kind ?? "rise_fall") === "multiplier") {
          if (!ctx.seed) { report.failed++; continue; }
          const c = (row.contract ?? {}) as { dir?: MultDir; multiplier?: number; tpCents?: number | null; slCents?: number | null; dcUntilMs?: number | null; dcFeeCents?: number; instrumentId?: string; openIndex?: number };
          const instrumentId = c.instrumentId ?? DEFAULT_INSTRUMENT_ID;
          const state = {
            dir: c.dir ?? ("up" as MultDir), entry: row.entryRate, multiplier: c.multiplier ?? 1,
            stakeCents: row.stakeCents, tpCents: c.tpCents ?? null, slCents: c.slCents ?? null,
            dcUntilMs: c.dcUntilMs ?? null, dcFeeCents: c.dcFeeCents ?? 0,
          };
          const decision = this.pool ? await this.pool.getDecision(row.id) : null;
          if (decision) {
            const durationMs = poolMultiplierDurationMs(decision.seed, decision.nonce);
            if (nowMs >= row.openedAtMs + durationMs) {
              const won = decision.result === "win";
              const payout = won ? decision.payoutCents : 0;
              const feed = new InstrumentFeed(ctx.seed, instrumentById(instrumentId));
              const exit = feed.tickAt(feed.indexAt(nowMs, ctx.dayStartMs)).quote;
              const res = await this.repo.settlePosition({
                positionId: row.id, exitRate: exit, result: decision.result,
                multiplier: won ? payout / row.stakeCents : 0, payoutCents: payout,
              });
              if (res.settled) {
                report.settled++;
                if (won && this.pool) { try { await this.pool.commit(row.id); } catch { /* reservation keeps the budget protected */ } }
              } else report.noop++;
            } else {
              const ok = this.game.rearmMultiplier(row.id, {
                userId: row.userId, siteId: row.siteId ?? null, stakeCents: row.stakeCents, instrumentId,
                openedAtMs: row.openedAtMs, nonce: decision.nonce, state,
                decided: { result: decision.result, payoutCents: decision.result === "win" ? decision.payoutCents : 0, durationMs },
                poolReserved: true,
              });
              if (ok) report.rearmed++; else report.noop++;
            }
            continue;
          }
          // No pool decision. A DEMO/MARKETER multiplier was decided at the cohort win-rate (not
          // persisted to the pool); reconstruct that SAME decision seed-deterministically so recovery is
          // identical. A pool-off statistical player's multiplier re-arms on the fair price path as before.
          const marketer = this.loadIsMarketer ? await this.loadIsMarketer(row.userId) : false;
          if (marketer && this.pool) {
            const ov = this.loadOverride ? await this.loadOverride(row.userId) : null;
            const winRate = ov?.winRate ?? ctx.cfg.targetWinRate;
            const durationMs = poolMultiplierDurationMs(ctx.seed, row.nonce);
            const won = seededWin(ctx.seed, row.nonce, winRate);
            const payoutCents = won ? row.stakeCents + (state.tpCents ?? 0) : 0;
            if (nowMs >= row.openedAtMs + durationMs) {
              const feed = new InstrumentFeed(ctx.seed, instrumentById(instrumentId));
              const exit = feed.tickAt(feed.indexAt(nowMs, ctx.dayStartMs)).quote;
              const res = await this.repo.settlePosition({
                positionId: row.id, exitRate: exit, result: won ? "win" : "loss",
                multiplier: won ? payoutCents / row.stakeCents : 0, payoutCents,
              });
              if (res.settled) report.settled++; else report.noop++;
            } else {
              const ok = this.game.rearmMultiplier(row.id, {
                userId: row.userId, siteId: row.siteId ?? null, stakeCents: row.stakeCents, instrumentId,
                openedAtMs: row.openedAtMs, nonce: row.nonce, state,
                decided: { result: won ? "win" : "loss", payoutCents, durationMs }, poolReserved: false,
              });
              if (ok) report.rearmed++; else report.noop++;
            }
            continue;
          }
          const ok = this.game.rearmMultiplier(row.id, {
            userId: row.userId, siteId: row.siteId ?? null, stakeCents: row.stakeCents, instrumentId,
            openedAtMs: row.openedAtMs, nonce: row.nonce, state, decided: null, poolReserved: false,
          });
          if (ok) report.rearmed++; else report.noop++;
          continue;
        }

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
              // A pool trade is never continuous: the controller decided it, not the curve.
              continuous: false, slPrice: null, tpPrice: null,
              // The SAME ticket the trader has been quoting since the trade opened (0184). A restart
              // must not renumber a live position.
              ticket: row.ticket ?? null,
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
            // The same rule `openPosition` applies: a continuous position can always be closed by
            // hand, because closing pays what the price says it is worth and there is no committed
            // outcome to protect. Without this a re-armed loser could not be closed at all, which is
            // half the bug the levels above fix.
            status: "open", sellable: this.game.hasPriceAxis || outcome.result === "win", gameDayId: row.gameDayId,
            configVersion: ctx.configVersion,
            nonce: row.nonce, poolControlled: false,
            /**
             * A RE-ARMED position comes back the way it was OPENED, levels and all.
             *
             * It used to come back with `continuous: false` and no levels, because there was nowhere
             * to keep them. That was not a cosmetic loss. The engine restarts on every deploy, so
             * routinely: a trader's stop silently disappeared, the position switched from the
             * continuous payout it was opened under to the committed step contract, and a loser that
             * could be closed by hand a second earlier could not be closed at all. The same trade
             * was priced one way before the restart and another way after it.
             *
             * Migration 0183 persists the levels, so `row` now carries them and the objection is
             * gone. `hasPriceAxis` is the GameServer's own test, the same one `openPosition` makes,
             * rather than a guess from the row: a brand that charts a line still has nothing to put
             * a level on and still keeps the committed contract.
             */
            continuous: this.game.hasPriceAxis,
            slPrice: row.slPrice ?? null,
            tpPrice: row.tpPrice ?? null,
            // The ticket the trade opened under (0184), for the same reason the levels are here: a
            // deploy must not change the number a trader is looking at.
            ticket: row.ticket ?? null,
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
