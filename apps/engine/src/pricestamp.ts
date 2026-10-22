import type { PriceAxis } from "@invest254/shared";
import type { GameRepository } from "./wallet.js";

/**
 * Display-price stamping, bolted onto a GameRepository without touching the money path.
 *
 * A position stores curve RATES. The terminal charts a PRICE, and the price axis is re-anchored at
 * every UTC midnight, so a rate on its own cannot be turned back into the number the player saw —
 * only the brand's day chain knows each day's anchor. Migration 0180 therefore records the price at
 * execution time, in `positions.entry_price` / `exit_price`.
 *
 * This wrapper is where that happens, and the shape is deliberate on three counts:
 *
 *  - The GameServer is untouched. It calls `openPosition` / `openContract` / `settlePosition` as
 *    before; the wrapper sits between it and the repository, so not one line of the open or settle
 *    path changes and the atomic money RPCs are called with exactly the arguments they always were.
 *
 *  - The stamp is FIRE-AND-FORGET. It is issued only after the money RPC has resolved — that is,
 *    after the trade has committed — and is never awaited, so a slow or failing display write cannot
 *    delay a trade, fail one, or leave the player waiting. A miss leaves the column null, which the
 *    client renders as "at market": the same thing it rendered before these columns existed.
 *
 *  - It applies only where there is an axis to anchor to. Brands that chart a line have no day chain
 *    (SiteRuntime.history is undefined), so there is nothing to stamp and the repository is handed
 *    through unwrapped.
 */
export interface PriceStampOptions {
  /** The brand's price axis, read per call so a rebuilt day chain is picked up. */
  axis: () => PriceAxis;
  /** Where a failed stamp goes. Never thrown — a display price is not worth a trade. */
  onError?: (err: Error, ctx: string) => void;
}

/**
 * Wrap `repo` so every position it opens or settles also gets its display prices recorded.
 *
 * Returns `repo` itself when it cannot stamp (no `setExecutionPrices`, e.g. the in-memory dev
 * repository), so callers need no capability check of their own.
 */
export function withPriceStamp(repo: GameRepository, opts: PriceStampOptions): GameRepository {
  const stampOne = repo.setExecutionPrices?.bind(repo);
  if (!stampOne) return repo;

  const stamp = (positionId: string): void => {
    // Deliberately not awaited: see the fire-and-forget note above. `void` + `catch` so a rejection
    // is logged rather than becoming an unhandled rejection that could take the engine down.
    void (async () => {
      try {
        // The axis knows its own instrument, so the symbol needs no extra plumbing to reach here
        // (migration 0182). Every trade settles on the brand's default instrument today, which is
        // exactly what this names; it becomes the ORDER's symbol when multi-symbol trading lands.
        const axis = opts.axis();
        await stampOne(positionId, axis, axis.instrument.symbol);
      } catch (err) {
        opts.onError?.(err as Error, `price-stamp ${positionId}`);
      }
    })();
  };

  // Object.create rather than a spread: the repository is a class instance, so its methods live on
  // the prototype and a spread would silently drop every one of them. This way the three overrides
  // below are own properties and everything else delegates to the real repository untouched.
  const wrapped: GameRepository = Object.create(repo);

  wrapped.openPosition = async (a) => {
    const r = await repo.openPosition(a);
    stamp(r.positionId);
    return r;
  };
  wrapped.openContract = async (a) => {
    const r = await repo.openContract(a);
    stamp(r.positionId);
    return r;
  };
  wrapped.settlePosition = async (a) => {
    const r = await repo.settlePosition(a);
    // Stamp whether or not this call was the one that settled it: `settled` is false on an
    // already-settled position (the RPC is idempotent), and the exit price may still be missing —
    // for instance when a crash landed between the settle and the stamp.
    stamp(a.positionId);
    return r;
  };

  return wrapped;
}
