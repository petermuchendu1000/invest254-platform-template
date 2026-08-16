import {
  decidePoolOutcome, poolLiveMultiplier, DEFAULT_POOL_KNOBS,
  type PoolDecision, type PoolKnobs,
} from "@invest254/shared";
import type { Querier } from "./wallet.js";

/**
 * Engine-side pool controller (docs/25 Phase 3b). Orchestrates the PURE brain
 * (@invest254/shared: decidePoolOutcome / poolLiveMultiplier) with the ATOMIC budget RPCs
 * (migration 0063: fn_pool_reserve / commit / release) and the decision audit (position_decision).
 *
 * Flow per pool-eligible (non-marketer) trade in a pool-mode brand:
 *   open   -> decide (win/loss/amount) from live pool state + EAT-day pacing, then RESERVE the win
 *             atomically (grant clamps to remaining budget; a clamp below stake becomes a loss),
 *             persist the decision.
 *   ticks  -> live multiplier follows the seeded reversing path to the decided endpoint.
 *   settle -> COMMIT the reservation (reserved -> paid). Budget is protected even if commit is
 *             deferred, because the reservation already reduced available.
 * Determinism (seed+nonce) makes every decision reproducible for audit + crash recovery.
 */

const EAT_OFFSET_MS = 3 * 3600 * 1000; // Africa/Nairobi = UTC+3, no DST
export function eatDay(ms: number): string { return new Date(ms + EAT_OFFSET_MS).toISOString().slice(0, 10); }
export function eatDayFraction(ms: number): number { return ((ms + EAT_OFFSET_MS) % 86_400_000) / 86_400_000; }

export interface PoolStateRow { amountCents: number; paidCents: number; reservedCents: number; }
export interface StoredDecision {
  positionId: string; siteId: string; poolDay: string;
  result: "win" | "loss"; multiplier: number; payoutCents: number; seed: string; nonce: number;
}
export interface PoolOutcome { result: "win" | "loss"; multiplier: number; payoutCents: number; }

/** Durable boundary for pool money + decisions. Two impls: Pg (RPCs) and in-memory (tests/dev). */
export interface PoolRepo {
  poolState(siteId: string, day: string): Promise<PoolStateRow>;
  reserve(siteId: string, day: string, positionId: string, amountCents: number): Promise<number>;
  commit(positionId: string): Promise<number>;
  release(positionId: string): Promise<number>;
  saveDecision(d: StoredDecision): Promise<void>;
  getDecision(positionId: string): Promise<StoredDecision | null>;
}

export class PoolController {
  constructor(
    private readonly repo: PoolRepo,
    private readonly knobs: Omit<PoolKnobs, "maxMultiplier"> = DEFAULT_POOL_KNOBS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Decide + atomically reserve a pool-eligible trade's outcome. Persists the decision. */
  async decideReserve(a: {
    siteId: string; stakeCents: number; positionId: string; nonce: number;
    openedAtMs: number; maxMultiplier: number; serverSeed: string;
  }): Promise<PoolOutcome> {
    const day = eatDay(a.openedAtMs);
    const st = await this.repo.poolState(a.siteId, day);
    const knobs: PoolKnobs = { ...this.knobs, maxMultiplier: a.maxMultiplier };
    const decision = decidePoolOutcome({
      stakeCents: a.stakeCents, pool: st, dayFraction: eatDayFraction(a.openedAtMs),
      knobs, serverSeed: a.serverSeed, nonce: a.nonce,
    });
    let result = decision.result, multiplier = decision.multiplier, payoutCents = decision.payoutCents;
    if (result === "win") {
      const reserved = await this.repo.reserve(a.siteId, day, a.positionId, payoutCents);
      if (reserved <= a.stakeCents) {
        // clamp left no real profit (or nothing available) -> loss; free any partial hold
        if (reserved > 0) await this.repo.release(a.positionId);
        result = "loss"; multiplier = 0; payoutCents = 0;
      } else if (reserved !== payoutCents) {
        payoutCents = reserved; multiplier = reserved / a.stakeCents;
      }
    }
    await this.repo.saveDecision({
      positionId: a.positionId, siteId: a.siteId, poolDay: day,
      result, multiplier, payoutCents, seed: a.serverSeed, nonce: a.nonce,
    });
    return { result, multiplier, payoutCents };
  }

  /** Commit a settled pool win (reserved -> paid). Idempotent; safe to skip on loss. */
  commit(positionId: string): Promise<number> { return this.repo.commit(positionId); }
  release(positionId: string): Promise<number> { return this.repo.release(positionId); }
  getDecision(positionId: string): Promise<StoredDecision | null> { return this.repo.getDecision(positionId); }

  /** Live multiplier at progress g for a decided pool position (seeded reversing path). */
  live(d: PoolOutcome, serverSeed: string, nonce: number, g: number): number {
    return poolLiveMultiplier(d as PoolDecision, serverSeed, nonce, g);
  }
}

// ── Postgres impl (the 0062/0063 RPCs) ────────────────────────────────────────────────────────────
const n = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

export class PgPoolRepo implements PoolRepo {
  constructor(private readonly q: Querier) {}
  async poolState(siteId: string, day: string): Promise<PoolStateRow> {
    const r = await this.q.query(
      "select amount_cents, paid_cents, reserved_cents from withdrawal_pool where site_id=$1 and trade_day=$2",
      [siteId, day]);
    if (!r.rows.length) return { amountCents: 0, paidCents: 0, reservedCents: 0 };
    const x = r.rows[0];
    return { amountCents: n(x.amount_cents), paidCents: n(x.paid_cents), reservedCents: n(x.reserved_cents) };
  }
  async reserve(siteId: string, day: string, positionId: string, amountCents: number): Promise<number> {
    const r = await this.q.query("select fn_pool_reserve($1::uuid,$2::date,$3::uuid,$4) as g", [siteId, day, positionId, amountCents]);
    return n(r.rows[0].g);
  }
  async commit(positionId: string): Promise<number> {
    const r = await this.q.query("select fn_pool_commit($1::uuid) as c", [positionId]); return n(r.rows[0].c);
  }
  async release(positionId: string): Promise<number> {
    const r = await this.q.query("select fn_pool_release($1::uuid) as c", [positionId]); return n(r.rows[0].c);
  }
  async saveDecision(d: StoredDecision): Promise<void> {
    await this.q.query(
      `insert into position_decision(position_id, site_id, pool_day, decided_result, decided_multiplier, decided_payout_cents, decision_seed, pacing_snapshot)
       values ($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7,$8::jsonb)
       on conflict (position_id) do nothing`,
      [d.positionId, d.siteId, d.poolDay, d.result, d.multiplier, d.payoutCents, d.seed, JSON.stringify({ nonce: d.nonce })]);
  }
  async getDecision(positionId: string): Promise<StoredDecision | null> {
    const r = await this.q.query(
      "select position_id, site_id, pool_day, decided_result, decided_multiplier, decided_payout_cents, decision_seed, pacing_snapshot from position_decision where position_id=$1",
      [positionId]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return {
      positionId: String(x.position_id), siteId: String(x.site_id),
      poolDay: x.pool_day instanceof Date ? x.pool_day.toISOString().slice(0, 10) : String(x.pool_day),
      result: x.decided_result, multiplier: n(x.decided_multiplier), payoutCents: n(x.decided_payout_cents),
      seed: String(x.decision_seed), nonce: n((x.pacing_snapshot ?? {}).nonce),
    };
  }
}

// ── In-memory impl (tests/dev): mirrors the RPC semantics exactly (clamp/idempotent/hard-cap) ───────
export class InMemoryPoolRepo implements PoolRepo {
  private pools = new Map<string, PoolStateRow>();          // `${site}:${day}` -> state
  private outstanding = new Map<string, { site: string; day: string; amount: number }>(); // position -> reservation
  private decisions = new Map<string, StoredDecision>();
  setPool(siteId: string, day: string, amountCents: number): void {
    const k = `${siteId}:${day}`; const cur = this.pools.get(k);
    this.pools.set(k, { amountCents, paidCents: cur?.paidCents ?? 0, reservedCents: cur?.reservedCents ?? 0 });
  }
  async poolState(siteId: string, day: string): Promise<PoolStateRow> {
    return this.pools.get(`${siteId}:${day}`) ?? { amountCents: 0, paidCents: 0, reservedCents: 0 };
  }
  async reserve(siteId: string, day: string, positionId: string, amountCents: number): Promise<number> {
    if (this.outstanding.has(positionId)) return this.outstanding.get(positionId)!.amount; // idempotent
    const k = `${siteId}:${day}`; const st = this.pools.get(k);
    if (!st || amountCents <= 0) return 0;
    const avail = st.amountCents - st.paidCents - st.reservedCents;
    if (avail <= 0) return 0;
    const grant = Math.min(amountCents, avail);
    st.reservedCents += grant;
    this.outstanding.set(positionId, { site: siteId, day, amount: grant });
    return grant;
  }
  async commit(positionId: string): Promise<number> {
    const o = this.outstanding.get(positionId); if (!o) return 0;
    const st = this.pools.get(`${o.site}:${o.day}`)!; st.reservedCents -= o.amount; st.paidCents += o.amount;
    this.outstanding.delete(positionId); return o.amount;
  }
  async release(positionId: string): Promise<number> {
    const o = this.outstanding.get(positionId); if (!o) return 0;
    const st = this.pools.get(`${o.site}:${o.day}`)!; st.reservedCents -= o.amount;
    this.outstanding.delete(positionId); return o.amount;
  }
  async saveDecision(d: StoredDecision): Promise<void> { this.decisions.set(d.positionId, d); }
  async getDecision(positionId: string): Promise<StoredDecision | null> { return this.decisions.get(positionId) ?? null; }
}
