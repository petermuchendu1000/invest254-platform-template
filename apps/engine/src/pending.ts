import { pendingDirection, pendingLevelValid, pendingTriggered, type PendingKind } from "@invest254/shared/pending";
import type { Direction } from "@invest254/shared/types";

/**
 * Pending orders: the instructions a trader armed at a price, waiting for the market to reach them.
 *
 * MetaTrader's chart menu is built around placing one (`Sell Limit 1  219.306`), and its four types
 * are the whole of what this holds. An order is NOT a position and holds no money: nothing is
 * debited while it waits, and the only thing it ever causes is the ordinary `openPosition` call a
 * market order makes, once, when its level is reached.
 *
 * The rules themselves (which types a level allows, and whether a level has been reached) are in
 * `@invest254/shared/pending`, which the browser calls too. The engine is the authority; sharing
 * the functions is what stops the row a trader clicked promising a fill this would not make.
 *
 * ── Why this is its own object ─────────────────────────────────────────────────────────────────
 *
 * The Game holds open positions and settles them. A pending order has none of that: no stake taken,
 * no multiplier, nothing to settle, and its whole life is one test per tick. Folding it into
 * `Position` would put four nullable columns and an `if` on every path that touches money, for a
 * record that never touches any. It is kept beside the game instead, and the game asks it one
 * question per tick.
 */

export interface PendingOrder {
  id: string;
  userId: string;
  kind: PendingKind;
  symbol: string;
  stakeCents: number;
  triggerPrice: number;
  /** Armed WITH the position, so an order placed with a stop opens a protected position. */
  slPrice: number | null;
  tpPrice: number | null;
  durationS: number;
  createdAtMs: number;
}

/** What the engine does with an order whose level the market has reached. */
export type FillOutcome =
  | { ok: true; positionId: string }
  | { ok: false; reason: string };

/**
 * The persistence seam, on the same terms as `setPositionLevels` in the wallet repository: every
 * method is optional, so the in-memory development repository and every test fake keep working, and
 * a write that fails leaves the order armed in memory rather than refusing to arm it at all.
 */
export interface PendingOrderStore {
  insertPendingOrder?(o: PendingOrder & { siteId: string | null }): Promise<void>;
  markPendingFilled?(id: string, positionId: string): Promise<void>;
  markPendingCanceled?(id: string): Promise<void>;
  /** Boot: every order still waiting, so a deploy does not disarm them. */
  listLivePendingOrders?(siteId: string | null): Promise<PendingOrder[]>;
}

export class RejectedOrder extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RejectedOrder";
  }
}

export class PendingOrders {
  private readonly orders = new Map<string, PendingOrder>();

  constructor(
    private readonly store: PendingOrderStore,
    private readonly siteId: string | null,
    /** Opens the position when an order fills. The Game's own `openPosition`, nothing else. */
    private readonly open: (o: PendingOrder, direction: Direction) => Promise<{ positionId: string }>,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  /** Re-arm everything that was still waiting when the engine last stopped. */
  async recover(): Promise<number> {
    const list = this.store.listLivePendingOrders?.bind(this.store);
    if (!list) return 0;
    const rows = await list(this.siteId);
    for (const o of rows) this.orders.set(o.id, o);
    return rows.length;
  }

  /**
   * Arm an order.
   *
   * Refused rather than armed when the level is on the wrong side of the market: such an order
   * would fill on the very next tick and is a market order wearing the wrong name. MetaTrader
   * refuses it with "Invalid price" and so does this.
   */
  async place(input: {
    userId: string;
    kind: PendingKind;
    symbol: string;
    stakeCents: number;
    triggerPrice: number;
    slPrice?: number | null;
    tpPrice?: number | null;
    durationS: number;
    /** The market now, which is the only thing that can say whether the level is on the right side. */
    marketPrice: number;
  }): Promise<PendingOrder> {
    if (!Number.isFinite(input.stakeCents) || input.stakeCents <= 0) {
      throw new RejectedOrder("INVALID_VOLUME", "the volume must be greater than zero");
    }
    if (!pendingLevelValid(input.kind, input.triggerPrice, input.marketPrice)) {
      throw new RejectedOrder(
        "INVALID_PRICE",
        "the level is on the wrong side of the market for this order type, so it would fill immediately",
      );
    }
    const order: PendingOrder = {
      id: this.newId(),
      userId: input.userId,
      kind: input.kind,
      symbol: input.symbol,
      stakeCents: Math.round(input.stakeCents),
      triggerPrice: input.triggerPrice,
      slPrice: Number.isFinite(input.slPrice as number) ? input.slPrice ?? null : null,
      tpPrice: Number.isFinite(input.tpPrice as number) ? input.tpPrice ?? null : null,
      durationS: input.durationS,
      createdAtMs: this.now(),
    };
    this.orders.set(order.id, order);
    // Fire-and-forget, exactly as `persistLevels` is: an order the trader can see is worth more
    // than one that refuses to arm because the database hiccuped, and a missed write costs the
    // order only across a restart, which is the behaviour before this existed.
    const insert = this.store.insertPendingOrder?.bind(this.store);
    if (insert) {
      void insert({ ...order, siteId: this.siteId }).catch((err: unknown) => {
        console.warn(`[pending] persisting ${order.id} failed:`, (err as Error)?.message ?? err);
      });
    }
    return order;
  }

  /** Cancel one. Only the trader who armed it can, which is what `userId` is checked for. */
  async cancel(id: string, userId: string): Promise<PendingOrder> {
    const order = this.orders.get(id);
    if (!order) throw new RejectedOrder("NOT_FOUND", "that order is no longer waiting");
    if (order.userId !== userId) throw new RejectedOrder("NOT_YOURS", "that order belongs to another account");
    this.orders.delete(id);
    const mark = this.store.markPendingCanceled?.bind(this.store);
    if (mark) {
      void mark(id).catch((err: unknown) => {
        console.warn(`[pending] cancelling ${id} failed:`, (err as Error)?.message ?? err);
      });
    }
    return order;
  }

  /** Everything this trader still has waiting, newest last. */
  list(userId: string): PendingOrder[] {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** For the tick loop: whether there is anything at all to check, so a quiet brand costs nothing. */
  get size(): number { return this.orders.size; }

  /**
   * One tick's work: fill every order this symbol's price has reached.
   *
   * Removed from the map BEFORE the position is opened, so a slow open cannot be entered twice by
   * the next tick; put back if the open fails, because an order that could not be filled is still
   * an order the trader armed. The database's `filled_position_id` is the second guard, for a
   * replay across a restart.
   */
  async step(symbol: string, price: number): Promise<Array<{ order: PendingOrder; outcome: FillOutcome }>> {
    if (this.orders.size === 0 || !Number.isFinite(price)) return [];
    const due: PendingOrder[] = [];
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol) continue;
      if (pendingTriggered(o.kind, o.triggerPrice, price)) due.push(o);
    }
    const done: Array<{ order: PendingOrder; outcome: FillOutcome }> = [];
    for (const order of due) {
      this.orders.delete(order.id);
      try {
        const { positionId } = await this.open(order, pendingDirection(order.kind));
        const mark = this.store.markPendingFilled?.bind(this.store);
        if (mark) {
          void mark(order.id, positionId).catch((err: unknown) => {
            console.warn(`[pending] marking ${order.id} filled failed:`, (err as Error)?.message ?? err);
          });
        }
        done.push({ order, outcome: { ok: true, positionId } });
      } catch (err) {
        // The order stays armed: a fill that could not be made is not a fill, and a trader whose
        // balance was short for a moment should not silently lose the order they set.
        this.orders.set(order.id, order);
        done.push({ order, outcome: { ok: false, reason: (err as Error)?.message ?? "the order could not be filled" } });
      }
    }
    return done;
  }
}
