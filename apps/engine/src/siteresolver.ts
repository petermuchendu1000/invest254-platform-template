/**
 * Brand (site) resolution for the multiplexed engine.
 *
 * A WS connection names its brand by `?site=<slug|domain|id>` (or Host). At boot the engine seeds a
 * fast alias map (slug/domain/id → site_id) from the `sites` table. The problem this module fixes
 * (GAP 2): a brand ONBOARDED AFTER boot is absent from that map, so the old resolver threw
 * `unresolved site` and the new brand's live tick stream / trading was dead until a redeploy.
 *
 * SiteResolver closes that gap. On a cache MISS it performs a live lookup (an injected port; the
 * real query hits the `sites` table in server.ts) and caches the result, so a freshly onboarded
 * brand serves immediately with ZERO restart. A short negative cache stops a bad/unknown ref from
 * hammering the DB on every (re)connect, and concurrent misses for the same ref coalesce into one
 * lookup. The class is pure + injectable so the real Pg query stays in server.ts and every path is
 * unit-testable with a fake lookup.
 *
 * Note on staleness: like the previous boot-only map, a positive alias is cached for the process
 * lifetime (a paused/archived brand keeps resolving until restart — unchanged behaviour). The new
 * capability is purely additive: refs unknown at boot now resolve live instead of being rejected.
 */

import { normalizeHost } from "@invest254/shared";

/** Resolve a normalized brand ref (slug|domain|id, lower-cased, trimmed) to a site_id, or null. */
export type SiteLookup = (ref: string) => Promise<string | null>;
export interface SiteResolverOptions {
  /** Boot-time aliases: ref (slug|domain|id, any case) → site_id. */
  aliases?: Iterable<readonly [string, string]>;
  /** Live lookup for a ref not in the alias cache. Omit for in-memory dev — a miss stays a miss. */
  lookup?: SiteLookup;
  /** Negative-cache TTL for unknown refs, in ms (default 30_000). */
  negativeTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

function norm(s: string): string {
  return normalizeHost(s);
}

export class SiteResolver {
  private readonly aliases = new Map<string, string>();
  private readonly negative = new Map<string, number>(); // ref → expiry timestamp (ms)
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly lookup: SiteLookup | undefined;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  constructor(opts: SiteResolverOptions = {}) {
    if (opts.aliases) for (const [k, v] of opts.aliases) this.aliases.set(norm(k), v);
    this.lookup = opts.lookup;
    this.negativeTtlMs = opts.negativeTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Cache a positive alias (both the ref and the site_id itself) and clear any negative entry.
   * Lets an out-of-band signal (e.g. an onboarding NOTIFY) pre-warm a brand without a DB round-trip.
   */
  add(ref: string, siteId: string): void {
    const k = norm(ref);
    this.aliases.set(k, siteId);
    this.aliases.set(norm(siteId), siteId);
    this.negative.delete(k);
  }

  /** Resolve one ref to a site_id, or null if empty/unknown/inactive. Never throws on a miss. */
  async resolve(ref: string | null | undefined): Promise<string | null> {
    const key = norm(ref ?? "");
    if (!key) return null;

    const cached = this.aliases.get(key);
    if (cached) return cached;

    if (!this.lookup) return null;

    const negExp = this.negative.get(key);
    if (negExp !== undefined) {
      if (this.now() < negExp) return null;
      this.negative.delete(key); // TTL elapsed → allow a retry
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async (): Promise<string | null> => {
      try {
        const id = await this.lookup!(key);
        if (id) {
          this.aliases.set(key, id);
          this.aliases.set(norm(id), id);
          return id;
        }
        this.negative.set(key, this.now() + this.negativeTtlMs);
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
