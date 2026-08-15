import { normalizeHost } from "@invest254/shared";

/**
 * Multi-tenant CORS allowance (GAP 3).
 *
 * The platform serves MANY brand domains from ONE API and onboards new brands continuously, so a
 * static `CORS_ALLOWED_ORIGINS` list can never keep up — hardening CORS would silently lock new
 * clients out of the backend. This keeps a fast, in-memory Set of ACTIVE brand hosts (normalized
 * apex form) so the CORS preflight decision stays synchronous and cheap, refreshed periodically
 * from the `sites` table (and seedable/pushable so a just-onboarded brand is allowed immediately).
 *
 * `allows(origin)` folds the request Origin to its apex host (via the shared normalizeHost, which
 * strips scheme/port and `www.`), so both `https://tamutraders.com` and `https://www.tamutraders.com`
 * are accepted for a brand whose `primary_domain` is `tamutraders.com`. Unknown origins are rejected.
 */
export type BrandHostSource = () => Promise<string[]>;

export class BrandOriginAllowlist {
  private hosts = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly source: BrandHostSource, private readonly refreshMs = 60_000) {}

  /** Load the initial set and start the periodic refresh (unref'd so it never holds the process open). */
  async init(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh().catch(() => { /* keep last good set */ }); }, this.refreshMs);
    this.timer.unref?.();
  }

  /** Replace the host set from the source. On error the previous set is kept (fail-safe). */
  async refresh(): Promise<void> {
    const rows = await this.source();
    const next = new Set<string>();
    for (const d of rows) {
      const h = normalizeHost(d);
      if (h) next.add(h);
    }
    this.hosts = next;
  }

  /** Pre-warm a single brand host (e.g. right after onboarding) without waiting for the interval. */
  add(host: string): void {
    const h = normalizeHost(host);
    if (h) this.hosts.add(h);
  }

  /** True if the given request Origin belongs to a known active brand domain (apex or www). */
  allows(origin: string): boolean {
    const h = normalizeHost(origin);
    return h.length > 0 && this.hosts.has(h);
  }

  /** Current number of allowed brand hosts (for logging/diagnostics). */
  get size(): number { return this.hosts.size; }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
}
