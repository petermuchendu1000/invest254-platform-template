import type { Querier } from "./wallet.js";
import type { ListenClient, ListenConnector } from "./gameconfig.js";

/**
 * Live per-brand `sites` flags — currently the pool-brain switch `pool_mode` (docs/25).
 *
 * Before this, the engine read `sites.pool_mode` ONCE at boot into a static map, so toggling a brand's
 * pool mode (or onboarding a new brand) needed a redeploy. SitesStore keeps it current with the SAME
 * two independent freshness paths as SiteGameConfigStore, so an operator flip lands in the running
 * engine in milliseconds and a brand added after boot is picked up automatically:
 *   - PUSH  — `LISTEN sites_changed` (migration 0088 trigger fires pg_notify with the changed site_id);
 *   - POLL  — a low-frequency full re-read fallback (covers a dropped LISTEN / pooled deployments).
 *
 * The pool AMOUNT/default are already read live per trade (fn_pool_ensure_day / poolState); only the
 * on/off flag lived in memory, which is what this closes. Read path is a synchronous map lookup on the
 * trade hot path (poolModeFor), exactly like poolModeBySite was.
 */
export const SITES_CHANNEL = "sites_changed";

export interface SitesStoreOptions {
  /** Poll fallback interval. Set 0 to disable polling (LISTEN only). Default 30s. */
  pollMs?: number;
  /** Opens a dedicated connection for LISTEN. Omit to run poll-only. */
  connect?: ListenConnector;
  /** Reconnect backoff after a LISTEN connection error. Default 5s. */
  reconnectMs?: number;
  onError?: (err: Error, ctx: string) => void;
  /** Invoked when a brand's pool_mode actually changes (add/flip/remove) — for operator-visible logs. */
  onChange?: (siteId: string, poolMode: boolean) => void;
}

export class SitesStore {
  private poolMode = new Map<string, boolean>();
  private loaded = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private listenClient: ListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly q: Querier, private readonly opts: SitesStoreOptions = {}) {}

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.error(`[sites] ${ctx}:`, err.message);
  }

  /** Whether this brand is governed by the pool controller RIGHT NOW (synchronous; hot-path safe). */
  poolModeFor(siteId: string): boolean { return this.poolMode.get(siteId) === true; }
  /** Count of pool-mode brands (for boot/health logging). */
  poolModeBrandCount(): number { let n = 0; for (const v of this.poolMode.values()) if (v) n++; return n; }
  isLoaded(): boolean { return this.loaded; }

  /** Load all active brands' pool_mode, then start push + poll refresh. */
  async init(): Promise<void> {
    await this.refreshAll();
    this.loaded = true;
    this.startPolling();
    void this.startListening();
  }

  /** Emit onChange only when a brand's effective pool_mode actually flips (loaded state only). */
  private applyOne(siteId: string, next: boolean): void {
    const prev = this.poolMode.get(siteId) === true;
    if (next) this.poolMode.set(siteId, true); else this.poolMode.delete(siteId);
    if (this.loaded && prev !== next) { try { this.opts.onChange?.(siteId, next); } catch { /* logging must never break refresh */ } }
  }

  /** Full re-read of every active brand's pool_mode (poll path + initial load). Diffs to emit onChange. */
  async refreshAll(): Promise<void> {
    const r = await this.q.query("select id, pool_mode from sites where status = 'active'", []);
    const next = new Map<string, boolean>();
    for (const row of r.rows) next.set(String(row.id), row.pool_mode === true);
    // union of keys so a brand that disappeared (deactivated/deleted) also flips to false
    for (const id of new Set<string>([...this.poolMode.keys(), ...next.keys()])) {
      this.applyOne(id, next.get(id) === true);
    }
  }

  /** Refresh ONE brand from a notification payload (add/flip/remove). */
  async refreshOne(siteId: string): Promise<void> {
    const r = await this.q.query("select pool_mode, status from sites where id = $1", [siteId]);
    const active = r.rows.length > 0 && r.rows[0].status === "active";
    this.applyOne(siteId, active && r.rows[0].pool_mode === true);
  }

  private startPolling(): void {
    const ms = this.opts.pollMs ?? 30_000;
    if (ms <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refreshAll().catch((err) => this.report(err as Error, "poll"));
    }, ms);
    this.pollTimer.unref?.();
  }

  private async startListening(): Promise<void> {
    if (!this.opts.connect || this.stopped || this.listenClient) return;
    try {
      const client = await this.opts.connect();
      this.listenClient = client;
      client.on("notification", (msg) => {
        if (msg.channel !== SITES_CHANNEL) return;
        const siteId = msg.payload;
        const p = siteId ? this.refreshOne(siteId) : this.refreshAll();
        void p.catch((err) => this.report(err as Error, "notify"));
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.dropListener();
        this.scheduleReconnect();
      });
      await client.query(`listen ${SITES_CHANNEL}`);
      // A change may have landed between the initial load and LISTEN being armed.
      await this.refreshAll();
    } catch (err) {
      this.report(err as Error, "listen-connect");
      this.dropListener();
      this.scheduleReconnect();
    }
  }

  private dropListener(): void {
    try { this.listenClient?.release?.(true); } catch { /* already gone */ }
    this.listenClient = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.startListening();
    }, this.opts.reconnectMs ?? 5000);
    this.reconnectTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.dropListener();
  }
}
