import type { Querier } from "./wallet.js";
import type { PlatformService } from "./platform.js";

/**
 * POOL-1 (docs/46, migration 0164): the per-brand pool overview and the automatic daily distribution.
 * Authorization lives in the RPCs (a platform admin: its own platform; the System owner: any, or all).
 */
export interface PoolOverviewRow {
  siteId: string; name: string; slug: string; platformId: string | null; platformName: string | null;
  poolMode: boolean; withdrawalsEnabled: boolean; defaultCents: number; todayCents: number; paidCents: number;
  reservedCents: number; availableCents: number; todaySet: boolean; pendingCount: number; pendingCents: number;
  paid7dCents: number; lastChangedAtMs: number | null;
}
export type PoolAutoMode = "dynamic" | "equal" | "off";
export interface PoolAutoSettings {
  platformId: string; mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number; isDefault: boolean;
  lastRunAtMs: number | null; lastRunOk: boolean | null; lastRunMessage: string | null; updatedAtMs: number | null;
}
export interface PoolAutoRunResult { platformId: string; mode: PoolAutoMode; ok: boolean; message: string; totalCents: number; brands: number }

export interface PoolOpsRepository {
  overview(actor: string, role: string, platformId: string | null): Promise<PoolOverviewRow[]>;
  getSettings(actor: string, role: string, platformId: string): Promise<PoolAutoSettings>;
  setSettings(actor: string, role: string, platformId: string, s: { mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number }): Promise<void>;
  recordRun(platformId: string, ok: boolean, message: string): Promise<void>;
  /** Label the actor's most recent distribution for this platform (how it was made). */
  markLatest(actor: string, platformId: string | null, source: "manual" | "dynamic" | "auto"): Promise<void>;
  activePlatforms(): Promise<string[]>;
}

const n = (v: unknown): number => Number(v ?? 0);
const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

export class PgPoolOpsRepository implements PoolOpsRepository {
  constructor(private readonly q: Querier) {}
  async overview(actor: string, role: string, platformId: string | null): Promise<PoolOverviewRow[]> {
    const r = await this.q.query("select * from fn_pool_overview($1, $2, $3)", [actor, role, platformId]);
    return r.rows.map((x: Record<string, unknown>) => ({
      siteId: String(x.site_id), name: String(x.name), slug: String(x.slug),
      platformId: x.platform_id == null ? null : String(x.platform_id), platformName: x.platform_name == null ? null : String(x.platform_name),
      poolMode: Boolean(x.pool_mode), withdrawalsEnabled: Boolean(x.withdrawals_enabled),
      defaultCents: n(x.default_cents), todayCents: n(x.today_cents), paidCents: n(x.paid_cents), reservedCents: n(x.reserved_cents),
      availableCents: n(x.available_cents), todaySet: Boolean(x.today_set), pendingCount: n(x.pending_count), pendingCents: n(x.pending_cents),
      paid7dCents: n(x.paid_7d_cents), lastChangedAtMs: ms(x.last_changed_at),
    }));
  }
  async getSettings(actor: string, role: string, platformId: string): Promise<PoolAutoSettings> {
    const r = await this.q.query("select * from fn_pool_auto_settings_get($1, $2, $3)", [actor, role, platformId]);
    const x = r.rows[0] as Record<string, unknown>;
    return {
      platformId, mode: String(x.mode) as PoolAutoMode, dailyTotalCents: x.daily_total_cents == null ? null : n(x.daily_total_cents),
      lookbackDays: n(x.lookback_days), isDefault: Boolean(x.is_default), lastRunAtMs: ms(x.last_run_at),
      lastRunOk: x.last_run_ok == null ? null : Boolean(x.last_run_ok), lastRunMessage: x.last_run_message == null ? null : String(x.last_run_message),
      updatedAtMs: ms(x.updated_at),
    };
  }
  async setSettings(actor: string, role: string, platformId: string, s: { mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number }): Promise<void> {
    await this.q.query("select fn_pool_auto_settings_set($1, $2, $3, $4, $5, $6)", [actor, role, platformId, s.mode, s.dailyTotalCents, s.lookbackDays]);
  }
  async recordRun(platformId: string, ok: boolean, message: string): Promise<void> {
    await this.q.query("select fn_pool_auto_record_run($1, $2, $3)", [platformId, ok, message]);
  }
  async markLatest(actor: string, platformId: string | null, source: "manual" | "dynamic" | "auto"): Promise<void> {
    await this.q.query(
      `update platform_pool_distributions set source = $3
        where id = (select id from platform_pool_distributions
                     where distributed_by = $1 and platform_id is not distinct from $2::uuid
                     order by created_at desc, id desc limit 1)`, [actor, platformId, source]);
  }
  async activePlatforms(): Promise<string[]> {
    const r = await this.q.query(
      `select distinct p.id from platforms p join sites s on s.platform_id = p.id and s.status = 'active'
        where coalesce(p.status, 'active') = 'active' order by p.id`, []);
    return r.rows.map((x: Record<string, unknown>) => String(x.id));
  }
}

const kes = (c: number) => `KES ${Math.round(c / 100).toLocaleString("en-KE")}`;

export class PoolOpsService {
  constructor(private readonly repo: PoolOpsRepository, private readonly platform: PlatformService) {}
  overview(actor: string, role: string, platformId: string | null) { return this.repo.overview(actor, role, platformId); }
  settings(actor: string, role: string, platformId: string) { return this.repo.getSettings(actor, role, platformId); }
  async saveSettings(actor: string, role: string, platformId: string, s: { mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number }) {
    await this.repo.setSettings(actor, role, platformId, s);
    return this.repo.getSettings(actor, role, platformId);
  }
  markLatest(actor: string, platformId: string | null, source: "manual" | "dynamic" | "auto") { return this.repo.markLatest(actor, platformId, source); }

  /**
   * Apply one platform's automatic distribution now (the daily job calls this for every platform; the console's
   * "Run now" too). dynamic = demand-based water-fill over the configured daily total, or — when none is set —
   * the platform's CURRENT total, so turning it on never changes how much money is budgeted, only where it
   * goes; equal = even split of the configured total; off = nothing. The outcome is always recorded.
   */
  async runAuto(actor: string, role: string, platformId: string, source: "auto" | "dynamic" = "auto", extra: { configuredFloorCents?: number } = {}): Promise<PoolAutoRunResult> {
    const s = await this.repo.getSettings(actor, role, platformId);
    const done = async (ok: boolean, message: string, totalCents = 0, brands = 0): Promise<PoolAutoRunResult> => {
      await this.repo.recordRun(platformId, ok, message);
      return { platformId, mode: s.mode, ok, message, totalCents, brands };
    };
    if (s.mode === "off") return done(true, "Automatic distribution is off — budgets were left as set.");
    try {
      if (s.mode === "equal") {
        const total = s.dailyTotalCents ?? 0;
        const r = await this.platform.distributePool(actor, role, total, "equal", null, platformId);
        await this.repo.markLatest(actor, platformId, source);
        const brands = Object.keys(r.perSite).length;
        return done(true, `Split ${kes(total)} evenly across ${brands} brand(s).`, total, brands);
      }
      if (s.dailyTotalCents == null) {
        const prev = await this.platform.poolDemand({ lookbackDays: s.lookbackDays }, platformId);
        if (prev.totalCents === 0) return done(true, "Nothing to split yet: no daily total is set and the brands have no budget. Set a daily total to start.");
      }
      const r = await this.platform.distributePoolDynamic(actor, role, {
        lookbackDays: s.lookbackDays, ...(s.dailyTotalCents != null ? { totalCents: s.dailyTotalCents } : {}),
        ...(extra.configuredFloorCents ? { configuredFloorCents: extra.configuredFloorCents } : {}),
      }, platformId);
      await this.repo.markLatest(actor, platformId, source);
      const total = r.preview.suggestedTotalCents;
      return done(true, `Split ${kes(total)} across ${r.preview.rows.length} brand(s) by demand${r.preview.reserveCents > 0 ? `, ${kes(r.preview.reserveCents)} held in reserve` : ""}.`, total, r.preview.rows.length);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return done(false, m === "NO_ACTIVE_SITES" ? "No active brands with the pool on." : m);
    }
  }
  activePlatforms() { return this.repo.activePlatforms(); }
}
