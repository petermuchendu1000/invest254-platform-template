/**
 * Real-time (intra-day) withdrawal-pool reallocation — docs/25 §15.1.
 *
 * The daily allocator (scripts/pool_distribute_daily) sets each brand's payout budget once, at the
 * EAT-day start. This distributor reacts WITHIN the day: it is triggered by every confirmed real-cash
 * deposit (the existing `deposit_confirmed` LISTEN feed, migration 0071) and moves the platform's
 * UNDISTRIBUTED reserve onto whichever brands are now under-served relative to the water-fill ideal —
 * NEVER reducing a brand's already-granted budget (see `grantsFromIdeal` + fn_pool_topup_today's
 * greatest() / the withdrawal_pool hard invariant).
 *
 * Deposits arrive in bursts, so calls are DEBOUNCED (leading + trailing coalesce) to at most one
 * reallocation per `minIntervalMs` — cheap, thrash-free, and eventually-consistent. Pure decision
 * logic lives in @invest254/shared; all I/O is injected (loadInputs/apply) so this is unit-testable.
 */
import { grantsFromIdeal, type HeadroomGrant } from "@invest254/shared";

/** Live inputs for one reallocation pass. */
export interface RealtimeInputs {
  /** Operator's global envelope (platform_global_config.global_daily_pool_cents). 0/absent ⇒ inert. */
  envelopeCents: number;
  /** Per active pool-mode brand: its water-fill ideal for the envelope + today's committed budget. */
  rows: { siteId: string; idealCents: number; committedCents: number }[];
}

export interface PoolRealtimeOptions {
  /** Reads the envelope + per-brand ideal/committed. Called once per (debounced) pass. */
  loadInputs: () => Promise<RealtimeInputs>;
  /** Applies the never-clawback top-ups (→ fn_pool_topup_today). Only brands getting >0 are passed. */
  apply: (grants: { siteId: string; amountCents: number }[]) => Promise<void>;
  /** Debounce floor between passes (ms). Default 15s. */
  minIntervalMs?: number;
  onError?: (err: Error) => void;
  onApplied?: (grants: HeadroomGrant[]) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class PoolRealtimeDistributor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private pending = false;
  private lastRun = 0;
  private stopped = false;

  constructor(private readonly o: PoolRealtimeOptions) {}

  private clock(): number { return (this.o.now ?? Date.now)(); }

  /** Request a reallocation. Coalesces bursts; honours the min-interval floor. */
  trigger(): void {
    if (this.stopped) return;
    this.pending = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running) return;
    const min = this.o.minIntervalMs ?? 15_000;
    const wait = Math.max(0, min - (this.clock() - this.lastRun));
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, wait);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.running || !this.pending) return;
    this.running = true;
    this.pending = false;
    this.lastRun = this.clock();
    try {
      await this.runOnce();
    } catch (err) {
      this.o.onError?.(err as Error);
    } finally {
      this.running = false;
      if (this.pending) this.schedule(); // a trigger landed mid-run ⇒ trailing pass
    }
  }

  /** Compute + apply one reallocation pass. Exposed for the periodic backstop and tests. */
  async runOnce(): Promise<HeadroomGrant[]> {
    const { envelopeCents, rows } = await this.o.loadInputs();
    if (!(envelopeCents > 0) || rows.length === 0) return []; // inert until an envelope is configured
    const grants = grantsFromIdeal(rows, envelopeCents);
    const toApply = grants.filter((g) => g.grantCents > 0).map((g) => ({ siteId: g.siteId, amountCents: g.newAmountCents }));
    if (toApply.length > 0) {
      await this.o.apply(toApply);
      this.o.onApplied?.(grants);
    }
    return grants;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
