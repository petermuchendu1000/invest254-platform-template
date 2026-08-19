/**
 * PlatformGate — cached reader of the platform-wide master switches (migration 0092).
 *
 * The platform_superadmin global console can turn whole systems off across EVERY brand
 * (deposits / withdrawals / play / marketers / registrations) + set a maintenance banner.
 * This gate is consulted at the service chokepoints (API handlers + the engine's open-position
 * path). It caches the singleton for `ttlMs` so a high-frequency path (play) doesn't hit the DB
 * per action; a toggle propagates within one TTL (and the engine also LISTENs 'platform_config_changed').
 *
 * FAIL-OPEN: if the config row can't be read (DB blip, table missing on an un-migrated env), the gate
 * returns the last-known snapshot (initially all-ON). A read error must NEVER self-inflict a
 * platform-wide outage — turning systems OFF is always a deliberate, recorded admin action.
 */
export interface PlatformFlags {
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  playEnabled: boolean;
  marketersEnabled: boolean;
  registrationsEnabled: boolean;
  maintenanceMessage: string | null;
  version: number;
}

export type PlatformSystem = "deposits" | "withdrawals" | "play" | "marketers" | "registrations";

export const PLATFORM_ALL_ON: PlatformFlags = {
  depositsEnabled: true, withdrawalsEnabled: true, playEnabled: true,
  marketersEnabled: true, registrationsEnabled: true, maintenanceMessage: null, version: 0,
};

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export class PlatformGate {
  private cache: PlatformFlags = PLATFORM_ALL_ON;
  private at = 0;
  private inflight: Promise<PlatformFlags> | null = null;

  /** @param q injected query fn (null => dev/no-DB: everything ON). @param ttlMs cache TTL. */
  constructor(private readonly q: QueryFn | null, private readonly ttlMs = 5000) {}

  async flags(): Promise<PlatformFlags> {
    if (!this.q) return this.cache;
    if (Date.now() - this.at < this.ttlMs) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const r = await this.q!(
          "select deposits_enabled, withdrawals_enabled, play_enabled, marketers_enabled, " +
          "registrations_enabled, maintenance_message, version from platform_global_config where id");
        const x = r.rows[0];
        if (x) {
          this.cache = {
            depositsEnabled: x.deposits_enabled !== false,
            withdrawalsEnabled: x.withdrawals_enabled !== false,
            playEnabled: x.play_enabled !== false,
            marketersEnabled: x.marketers_enabled !== false,
            registrationsEnabled: x.registrations_enabled !== false,
            maintenanceMessage: (x.maintenance_message as string | null) ?? null,
            version: Number(x.version ?? 0),
          };
        }
      } catch { /* fail-open: keep last-known snapshot */ }
      this.at = Date.now();
      return this.cache;
    })();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  async allows(system: PlatformSystem): Promise<boolean> {
    const f = await this.flags();
    switch (system) {
      case "deposits": return f.depositsEnabled;
      case "withdrawals": return f.withdrawalsEnabled;
      case "play": return f.playEnabled;
      case "marketers": return f.marketersEnabled;
      case "registrations": return f.registrationsEnabled;
    }
  }

  /** Force the next flags() to re-read (call from a 'platform_config_changed' LISTEN handler). */
  invalidate(): void { this.at = 0; }
}
