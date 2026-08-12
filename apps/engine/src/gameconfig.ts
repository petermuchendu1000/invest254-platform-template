import {
  DEFAULT_VERSIONED_CONFIG, checkFeasible,
  type GameConfig, type VersionedGameConfig,
} from "@invest254/shared";
import type { Querier } from "./wallet.js";

/**
 * Live game configuration.
 *
 * Before this module the engine and the API both booted from the hardcoded
 * `DEFAULT_CONFIG`, so every value an operator saved in the admin panel was written to
 * `public.game_config` and then ignored. `GameConfigStore` is the missing link: it loads
 * the row, keeps it current, and hands the rest of the process a `VersionedGameConfig`.
 *
 * Freshness has two independent paths so a single failure cannot silently freeze config:
 *
 *   - **Push** — `LISTEN game_config_changed`. The migration-0028 trigger fires
 *     `pg_notify` on every write, so a save lands in the engine in milliseconds.
 *   - **Poll** — a low-frequency `select version` fallback. Covers a dropped LISTEN
 *     connection, a pgBouncer transaction-pooled deployment where LISTEN is unavailable,
 *     and the window between a reconnect and the next notification.
 *
 * Safety rules:
 *   - A candidate config that fails `checkFeasible` is REJECTED and the previous config
 *     stays live. The DB CHECK makes this near-impossible, but an engine that crash-loops
 *     on a bad row is a far worse outage than one that keeps serving the last good one.
 *   - Historical versions are resolved from the immutable `game_config_versions` table
 *     (with an in-process cache) so crash recovery re-prices a position with the exact
 *     parameters that were live when it opened.
 */

const CONFIG_COLUMNS =
  "house_edge, max_multiplier, min_stake, max_stake, min_withdrawal, default_duration_s, tick_rate_ms, drift_bias, volatility, target_win_rate, version";

export const CONFIG_CHANNEL = "game_config_changed";

/** Minimal LISTEN surface. `pg.Pool.connect()` satisfies this; kept structural for tests. */
export interface ListenClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  release?(err?: boolean): void;
}
export type ListenConnector = () => Promise<ListenClient>;

export interface GameConfigStoreOptions {
  /** Poll fallback interval. Set 0 to disable polling (LISTEN only). Default 15s. */
  pollMs?: number;
  /** Opens a dedicated connection for LISTEN. Omit to run poll-only. */
  connect?: ListenConnector;
  /** Reconnect backoff after a LISTEN connection error. Default 5s. */
  reconnectMs?: number;
  onError?: (err: Error, ctx: string) => void;
}

export type ConfigChangeListener = (next: VersionedGameConfig, prev: VersionedGameConfig) => void;

const toNum = (v: unknown): number => (typeof v === "string" ? Number(v) : Number(v));

/** Map a `game_config` / `game_config_versions` row to a VersionedGameConfig. */
export function mapConfigRow(x: Record<string, unknown>): VersionedGameConfig {
  return {
    houseEdge: toNum(x.house_edge),
    maxMultiplier: toNum(x.max_multiplier),
    minStakeCents: Math.round(toNum(x.min_stake)),
    maxStakeCents: Math.round(toNum(x.max_stake)),
    minWithdrawalCents: Math.round(toNum(x.min_withdrawal)),
    defaultDurationS: Math.round(toNum(x.default_duration_s)),
    tickRateMs: Math.round(toNum(x.tick_rate_ms)),
    driftBias: toNum(x.drift_bias),
    volatility: toNum(x.volatility),
    targetWinRate: toNum(x.target_win_rate),
    version: Math.round(toNum(x.version)),
  };
}

/** Read-only view the rest of the engine depends on (keeps SeedManager testable). */
export interface ConfigProvider {
  /** The config in force right now. Synchronous — safe on the tick hot path. */
  active(): VersionedGameConfig;
  /** The historical config for a version; falls back to `active()` for unknown/null. */
  forVersion(version: number | null | undefined): Promise<VersionedGameConfig>;
  /**
   * Optional live-change subscription. Present on the DB-backed stores (`GameConfigStore`,
   * `SiteGameConfigStore`); absent on `StaticConfigProvider`. Returns an unsubscribe fn.
   * The SiteRegistry uses it to rebuild a brand's pricing the instant its economy is edited.
   */
  subscribe?(listener: ConfigChangeListener): () => void;
}

/** Fixed-config provider for local dev, tests, and any no-database process. */
export class StaticConfigProvider implements ConfigProvider {
  constructor(private readonly cfg: VersionedGameConfig = DEFAULT_VERSIONED_CONFIG) {}
  active(): VersionedGameConfig { return this.cfg; }
  async forVersion(): Promise<VersionedGameConfig> { return this.cfg; }
}

export class GameConfigStore implements ConfigProvider {
  private cfg: VersionedGameConfig = DEFAULT_VERSIONED_CONFIG;
  private loaded = false;
  private readonly history = new Map<number, VersionedGameConfig>();
  private readonly listeners = new Set<ConfigChangeListener>();
  private pollTimer: NodeJS.Timeout | undefined;
  private listenClient: ListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing: Promise<VersionedGameConfig> | null = null;

  constructor(
    private readonly q: Querier,
    private readonly opts: GameConfigStoreOptions = {},
  ) {}

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.error(`[config] ${ctx}:`, err.message);
  }

  active(): VersionedGameConfig {
    if (!this.loaded) throw new Error("GameConfigStore not initialised — call init() first");
    return this.cfg;
  }

  /** Snapshot loaded at least once? Lets callers distinguish "default" from "loaded default". */
  isLoaded(): boolean { return this.loaded; }

  subscribe(l: ConfigChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Load the row once, seed the history cache, then start push + poll refresh. */
  async init(): Promise<VersionedGameConfig> {
    await this.refresh();
    this.loaded = true;
    this.startPolling();
    void this.startListening();
    return this.cfg;
  }

  /** Re-read `game_config` and swap it in if the version moved and the config is solvable. */
  async refresh(): Promise<VersionedGameConfig> {
    // Collapse concurrent refreshes (a NOTIFY arriving mid-poll) into one query.
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const r = await this.q.query(`select ${CONFIG_COLUMNS} from game_config where id = 1`, []);
        if (!r.rows.length) throw new Error("game_config singleton row is missing");
        const next = mapConfigRow(r.rows[0] as Record<string, unknown>);
        this.apply(next);
        return this.cfg;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Validate, cache and publish a candidate. Rejects infeasible configs, keeping the old one. */
  private apply(next: VersionedGameConfig): void {
    const verdict = checkFeasible(next);
    if (!verdict.ok) {
      this.report(
        new Error(`rejected game_config v${next.version}: ${verdict.reason}`),
        "apply",
      );
      return;
    }
    this.history.set(next.version, next);
    if (this.loaded && next.version === this.cfg.version) return;
    const prev = this.cfg;
    this.cfg = next;
    if (!this.loaded) return;                       // initial load is not a "change"
    for (const l of this.listeners) {
      try { l(next, prev); } catch (err) { this.report(err as Error, "listener"); }
    }
  }

  async forVersion(version: number | null | undefined): Promise<VersionedGameConfig> {
    if (version === null || version === undefined) return this.active();
    const hit = this.history.get(version);
    if (hit) return hit;
    try {
      const r = await this.q.query(`select ${CONFIG_COLUMNS} from game_config_versions where version = $1`, [version]);
      if (!r.rows.length) {
        // A position pointing at a version we cannot read is a data-integrity problem, but
        // refusing to recover it would strand the player's stake. Recover on live config
        // and make the substitution loud.
        this.report(new Error(`game_config version ${version} not found; recovering on v${this.cfg.version}`), "forVersion");
        return this.active();
      }
      const cfg = mapConfigRow(r.rows[0] as Record<string, unknown>);
      this.history.set(version, cfg);
      return cfg;
    } catch (err) {
      this.report(err as Error, "forVersion");
      return this.active();
    }
  }

  private startPolling(): void {
    const ms = this.opts.pollMs ?? 15_000;
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
        if (msg.channel !== CONFIG_CHANNEL) return;
        void this.refresh().catch((err) => this.report(err as Error, "notify"));
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.dropListener();
        this.scheduleReconnect();
      });
      await client.query(`listen ${CONFIG_CHANNEL}`);
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

/** Which fields changed between two configs — used for operator-visible change logs. */
export function configDiff(a: GameConfig, b: GameConfig): string[] {
  const keys: (keyof GameConfig)[] = [
    "houseEdge", "maxMultiplier", "minStakeCents", "maxStakeCents", "minWithdrawalCents",
    "defaultDurationS", "tickRateMs", "driftBias", "volatility", "targetWinRate",
  ];
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`);
}

/**
 * True when a change requires rebuilding the curve + settlement calibration (i.e. it
 * alters how a round is priced). Stake bounds and tick rate do not — they are applied
 * in place without disturbing any position that is already in flight.
 */
export function affectsPricing(a: GameConfig, b: GameConfig): boolean {
  return a.houseEdge !== b.houseEdge
    || a.maxMultiplier !== b.maxMultiplier
    || a.targetWinRate !== b.targetWinRate
    || a.volatility !== b.volatility
    || a.driftBias !== b.driftBias
    || a.defaultDurationS !== b.defaultDurationS;
}

/** NOTIFY channel the migration-0046 trigger fires (payload = the changed `site_id`). */
export const SITE_CONFIG_CHANNEL = "site_game_config_changed";

/**
 * Per-brand live game configuration — the multi-tenant sibling of {@link GameConfigStore}
 * and the closing piece of docs/22 Task C.
 *
 * One instance per site. It loads that brand's `site_game_config` row and keeps it current via
 * the same two independent freshness paths, scoped to the brand:
 *   - **Push** — `LISTEN site_game_config_changed`; the migration-0046 trigger fires `pg_notify`
 *     with the changed `site_id` as the payload, so this store ignores other brands' edits.
 *   - **Poll** — a low-frequency `select` fallback (covers dropped LISTEN / pooled deployments).
 *
 * Historical versions resolve from `site_game_config_versions` (per site), and any candidate that
 * fails `checkFeasible` is rejected so a bad save can never crash-loop or mis-price a brand.
 */
export class SiteGameConfigStore implements ConfigProvider {
  private cfg: VersionedGameConfig = DEFAULT_VERSIONED_CONFIG;
  private loaded = false;
  private readonly history = new Map<number, VersionedGameConfig>();
  private readonly listeners = new Set<ConfigChangeListener>();
  private pollTimer: NodeJS.Timeout | undefined;
  private listenClient: ListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing: Promise<VersionedGameConfig> | null = null;

  constructor(
    private readonly siteId: string,
    private readonly q: Querier,
    private readonly opts: GameConfigStoreOptions = {},
  ) {}

  private report(err: Error, ctx: string): void {
    if (this.opts.onError) this.opts.onError(err, `${ctx} [site ${this.siteId}]`);
    else console.error(`[config] ${ctx} [site ${this.siteId}]:`, err.message);
  }

  active(): VersionedGameConfig {
    if (!this.loaded) throw new Error(`SiteGameConfigStore(${this.siteId}) not initialised — call init() first`);
    return this.cfg;
  }

  /** Snapshot loaded at least once? Lets callers distinguish "default" from "loaded default". */
  isLoaded(): boolean { return this.loaded; }

  subscribe(l: ConfigChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Load the brand's row once, seed the history cache, then start push + poll refresh. */
  async init(): Promise<VersionedGameConfig> {
    await this.refresh();
    this.loaded = true;
    this.startPolling();
    void this.startListening();
    return this.cfg;
  }

  /** Re-read this brand's `site_game_config` and swap it in if the version moved and it's solvable. */
  async refresh(): Promise<VersionedGameConfig> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const r = await this.q.query(`select ${CONFIG_COLUMNS} from site_game_config where site_id = $1`, [this.siteId]);
        if (!r.rows.length) throw new Error(`no site_game_config for site ${this.siteId}`);
        this.apply(mapConfigRow(r.rows[0] as Record<string, unknown>));
        return this.cfg;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Validate, cache and publish a candidate. Rejects infeasible configs, keeping the old one. */
  private apply(next: VersionedGameConfig): void {
    const verdict = checkFeasible(next);
    if (!verdict.ok) {
      this.report(new Error(`rejected site_game_config v${next.version}: ${verdict.reason}`), "apply");
      return;
    }
    this.history.set(next.version, next);
    if (this.loaded && next.version === this.cfg.version) return;
    const prev = this.cfg;
    this.cfg = next;
    if (!this.loaded) return;                       // initial load is not a "change"
    for (const l of this.listeners) {
      try { l(next, prev); } catch (err) { this.report(err as Error, "listener"); }
    }
  }

  async forVersion(version: number | null | undefined): Promise<VersionedGameConfig> {
    if (version === null || version === undefined) return this.active();
    const hit = this.history.get(version);
    if (hit) return hit;
    try {
      const r = await this.q.query(
        `select ${CONFIG_COLUMNS} from site_game_config_versions where site_id = $1 and version = $2`,
        [this.siteId, version],
      );
      if (!r.rows.length) {
        this.report(new Error(`site_game_config version ${version} not found; recovering on v${this.cfg.version}`), "forVersion");
        return this.active();
      }
      const cfg = mapConfigRow(r.rows[0] as Record<string, unknown>);
      this.history.set(version, cfg);
      return cfg;
    } catch (err) {
      this.report(err as Error, "forVersion");
      return this.active();
    }
  }

  private startPolling(): void {
    const ms = this.opts.pollMs ?? 15_000;
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
        if (msg.channel !== SITE_CONFIG_CHANNEL) return;
        // Payload is the site_id that changed; ignore other brands' notifications.
        if (msg.payload && msg.payload !== this.siteId) return;
        void this.refresh().catch((err) => this.report(err as Error, "notify"));
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.dropListener();
        this.scheduleReconnect();
      });
      await client.query(`listen ${SITE_CONFIG_CHANNEL}`);
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
