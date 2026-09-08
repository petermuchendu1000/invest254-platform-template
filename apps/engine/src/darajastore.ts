import type { Querier } from "./wallet.js";
import type { ListenClient, ListenConnector } from "./gameconfig.js";
import { loadDarajaConfigFromDb } from "./admin.js";
import {
  makeDarajaClientFromConfig,
  type DarajaClient, type DarajaConfig,
  type StkPushArgs, type StkPushResult, type StkQueryResult, type B2cArgs, type B2cResult,
} from "./daraja.js";

/**
 * Live M-Pesa (Daraja) configuration.
 *
 * Before this store the API built the Daraja client ONCE at boot from `loadDarajaConfigFromDb`, so
 * every credential an operator saved in the admin panel (`public.mpesa_config`) was ignored until a
 * manual redeploy. That silently broke real deposits after a shortcode/key rotation. `DarajaConfigStore`
 * is the missing link: it loads the row, keeps it current, and hands the rest of the process a live
 * `DarajaClient` that always reflects the DB — exactly how {@link GameConfigStore} already hot-reloads
 * `game_config`.
 *
 * Freshness has two independent paths so a single failure cannot silently freeze credentials:
 *   - **Push** — `LISTEN mpesa_config_changed`. The migration-0114 trigger fires `pg_notify` on every
 *     write, so a save lands in the API within milliseconds.
 *   - **Poll** — a low-frequency re-read fallback. Covers a dropped LISTEN connection and pooled
 *     deployments where LISTEN is unavailable.
 *
 * The store IS a `DarajaClient`: it delegates every call to the current inner client and swaps that
 * client atomically when (and only when) the effective config changes. Callers (PaymentService) keep
 * a single stable reference. A change that leaves production credentials incomplete yields an
 * {@link UnconfiguredDarajaClient} (via `makeDarajaClientFromConfig`) whose calls fail loudly — never
 * a stub that could phantom-credit unpaid deposits.
 */
export const MPESA_CONFIG_CHANNEL = "mpesa_config_changed";

export interface DarajaConfigStoreOptions {
  /** Poll fallback interval. Set 0 to disable polling (LISTEN only). Default 30s. */
  pollMs?: number;
  /** Opens a dedicated connection for LISTEN. Omit to run poll-only. */
  connect?: ListenConnector;
  /** Reconnect backoff after a LISTEN connection error. Default 5s. */
  reconnectMs?: number;
  /** Environment used for per-field fallback when a DB field is empty. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  onError?: (err: Error, ctx: string) => void;
}

/** Stable, order-independent fingerprint of the DB config partial (used to detect real changes). */
function fingerprint(cfg: Partial<DarajaConfig>): string {
  const keys = Object.keys(cfg).sort();
  return JSON.stringify(keys.map((k) => [k, (cfg as Record<string, unknown>)[k]]));
}

export class DarajaConfigStore implements DarajaClient {
  private currentClient: DarajaClient;
  private fp = "";
  private loaded = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private listenClient: ListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing: Promise<void> | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly q: Querier, private readonly opts: DarajaConfigStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    // Pre-init client from env only; init() immediately re-resolves against the DB row.
    this.currentClient = makeDarajaClientFromConfig({}, this.env);
  }

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.error(`[payments] mpesa config ${ctx}:`, err.message);
  }

  /** The client in force right now. Safe to call on every request. */
  client(): DarajaClient { return this.currentClient; }

  /** Loaded the DB row at least once? */
  isLoaded(): boolean { return this.loaded; }

  // DarajaClient delegation — always routes to the current inner client.
  stkPush(a: StkPushArgs): Promise<StkPushResult> { return this.currentClient.stkPush(a); }
  stkPushQuery(checkoutRequestId: string): Promise<StkQueryResult> { return this.currentClient.stkPushQuery(checkoutRequestId); }
  b2cPayment(a: B2cArgs): Promise<B2cResult> { return this.currentClient.b2cPayment(a); }

  /** Load the row once, then start push + poll refresh. */
  async init(): Promise<void> {
    await this.refresh();
    this.loaded = true;
    this.startPolling();
    void this.startListening();
  }

  /** Re-read `mpesa_config` and rebuild the client if (and only if) the effective config changed. */
  async refresh(): Promise<void> {
    // Collapse concurrent refreshes (a NOTIFY arriving mid-poll) into one query.
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const dbCfg = await loadDarajaConfigFromDb(this.q);
        const next = fingerprint(dbCfg);
        if (this.loaded && next === this.fp) return; // no effective change
        this.fp = next;
        this.currentClient = makeDarajaClientFromConfig(dbCfg, this.env);
        if (this.loaded) {
          // Log the swap without secrets — only the resulting client kind.
          console.log(`[payments] mpesa_config reloaded; active client = ${this.currentClient.constructor.name}`);
        }
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private startPolling(): void {
    const ms = this.opts.pollMs ?? 30_000;
    if (ms <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh().catch((err) => this.report(err as Error, "poll"));
    }, ms);
    this.pollTimer.unref?.();
  }

  private async startListening(): Promise<void> {
    if (!this.opts.connect || this.stopped || this.listenClient) return;
    try {
      const client = await this.opts.connect();
      this.listenClient = client;
      client.on("notification", (msg) => {
        if (msg.channel !== MPESA_CONFIG_CHANNEL) return;
        void this.refresh().catch((err) => this.report(err as Error, "notify"));
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.dropListener();
        this.scheduleReconnect();
      });
      await client.query(`listen ${MPESA_CONFIG_CHANNEL}`);
      // A change may have landed between the initial load and LISTEN being armed.
      await this.refresh();
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
