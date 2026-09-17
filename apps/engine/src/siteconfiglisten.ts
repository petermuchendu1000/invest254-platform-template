import { SITE_CONFIG_CHANNEL, type ListenClient, type ListenConnector } from "./gameconfig.js";

/**
 * SharedSiteConfigListener (BUGLOG #35) — ONE session-pooler LISTEN connection multiplexed across
 * every brand's live game-config store, instead of one connection per brand.
 *
 * `site_game_config_changed` is a GLOBAL channel (payload = the site_id that changed), so a single
 * LISTEN receives every brand's config change. Previously each `SiteGameConfigStore` opened its own
 * dedicated connection on this same channel; with N brands that needs N session connections, but the
 * session pooler is tiny (PG_LISTEN_POOL_MAX). Past the ceiling the extra brands' connects timed out
 * forever ("[config] listen-connect: timeout exceeded"), so those brands only ever got config updates
 * via the 15s poll fallback (and spammed error logs).
 *
 * This owns the single connection and fans each notification out to the matching brand's `refresh()`.
 * The per-site stores stay poll-only (safety net), so a dropped shared connection degrades gracefully
 * to polling while it reconnects. Never throws into a handler; reconnects with backoff.
 */
export interface SharedSiteConfigListenerOptions {
  /** Opens the single session-pooler connection for the shared LISTEN. */
  connect: ListenConnector;
  /** Reconnect backoff after a connection error/drop. Default 5s. */
  reconnectMs?: number;
  onError?: (err: Error, ctx: string) => void;
}

export class SharedSiteConfigListener {
  private readonly handlers = new Map<string, () => void>();   // siteId -> the store's refresh()
  private client: ListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private starting = false;

  constructor(private readonly opts: SharedSiteConfigListenerOptions) {}

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.error(`[config] shared-listen ${ctx}:`, err.message);
  }

  /** Register a brand's refresh callback; opens the shared connection on the first registration. */
  register(siteId: string, refresh: () => void): void {
    this.handlers.set(siteId, refresh);
    if (!this.client && !this.starting) void this.start();
  }

  unregister(siteId: string): void {
    this.handlers.delete(siteId);
  }

  /** For diagnostics/tests: how many brands share this one connection. */
  size(): number { return this.handlers.size; }

  private dispatch(siteId: string | undefined): void {
    if (siteId) {
      const h = this.handlers.get(siteId);
      if (h) { try { h(); } catch (err) { this.report(err as Error, "notify"); } }
      return;
    }
    // No payload -> refresh every brand (conservative; matches the store's own fallback behaviour).
    for (const h of this.handlers.values()) {
      try { h(); } catch (err) { this.report(err as Error, "notify"); }
    }
  }

  private async start(): Promise<void> {
    if (this.stopped || this.client || this.starting) return;
    this.starting = true;
    try {
      const client = await this.opts.connect();
      this.client = client;
      client.on("notification", (msg) => {
        if (msg.channel !== SITE_CONFIG_CHANNEL) return;
        this.dispatch(msg.payload);
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.drop();
        this.scheduleReconnect();
      });
      await client.query(`listen ${SITE_CONFIG_CHANNEL}`);
      // A change may have landed before the LISTEN was armed (or during a reconnect) — resync all.
      this.dispatch(undefined);
    } catch (err) {
      this.report(err as Error, "listen-connect");
      this.drop();
      this.scheduleReconnect();
    } finally {
      this.starting = false;
    }
  }

  private drop(): void {
    try { this.client?.release?.(true); } catch { /* already gone */ }
    this.client = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped && this.handlers.size > 0) void this.start();
    }, this.opts.reconnectMs ?? 5_000);
    this.reconnectTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.drop();
  }
}
