import { type IncomingMessage } from "node:http";
import {
  InMemoryGameRepository, PgGameRepository, type GameRepository, type Querier,
} from "./wallet.js";
import { StaticConfigProvider, SiteGameConfigStore, type ConfigProvider, type ListenClient } from "./gameconfig.js";
import { SitesStore } from "./sitesstore.js";
import { PgUserOverridesRepository, type UserOverridesRepository } from "./overrides.js";
import { PoolController, PgPoolRepo } from "./poolcontroller.js";
import { makePgPools } from "./pgpools.js";
import { SiteRegistry } from "./siteregistry.js";
import { SiteResolver, type SiteLookup } from "./siteresolver.js";
import { startMultiEngine } from "./multiengine.js";
import { DepositNotifier, type DepositListenClient } from "./platformlive.js";
import { makeVerifier } from "./auth.js";
import { DEFAULT_VERSIONED_CONFIG, PlatformGate } from "@invest254/shared";

/**
 * Multiplexed engine entrypoint (multi-tenant).
 *
 * One process serves every brand: a SiteRegistry builds a per-site SeedManager + GameServer on
 * demand (see siteregistry.ts), and the WS layer (multiengine.ts) binds each socket to its brand
 * and fans out per-site. A brand is resolved from the connection's `?site=<slug|id>` (or Host),
 * and — when a JWT verifier is configured — the token's `site` claim must match.
 *
 * Config: each brand prices from its own `site_game_config` row via a per-site SiteGameConfigStore
 * that hot-reloads on `LISTEN site_game_config_changed` (+ a poll fallback). The SiteRegistry
 * subscribes to it, so editing a brand's economy re-prices its next round without a redeploy.
 *
 * Without DATABASE_URL the engine runs fully in-memory for local dev (single default brand).
 */
const PORT = Number(process.env.PORT ?? 8080);
const MASTER_SEED = process.env.MASTER_SEED ?? process.env.SERVER_SEED ?? "dev-master-seed-0001";
const ONLINE_FLOOR = Number(process.env.ONLINE_FLOOR ?? 0);
const DEFAULT_SITE = process.env.DEFAULT_SITE_ID ?? "00000000-0000-0000-0000-000000000001";

const usingDb = Boolean(process.env.DATABASE_URL);
const verifier = makeVerifier();
if (usingDb && !verifier) {
  throw new Error("AUTH: a JWT verifier is required when DATABASE_URL is set (set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)");
}

let repo: GameRepository;
// Platform master switch (migration 0092) — gates new positions platform-wide. Set in DB mode only.
let platformGate: PlatformGate | undefined;
let overridesRepo: UserOverridesRepository | undefined;
let configFor: (siteId: string) => ConfigProvider | Promise<ConfigProvider>;
let masterSeedFor: ((siteId: string) => string | undefined) | undefined;
// docs/25: pool controller (shared; site passed per-call) + per-brand pool_mode flag. Only in DB mode.
let poolController: PoolController | undefined;
// docs/25 + migration 0088: pool_mode is kept LIVE via SitesStore (LISTEN sites_changed + poll), so a
// toggle or a new brand applies without redeploy. Replaces the old boot-time static map.
let sitesStore: SitesStore | undefined;
// docs/25 + migration 0084: canonical marketer/demo classifier, shared by pool exemption + money routing.
let loadIsMarketer: ((userId: string) => Promise<boolean>) | undefined;
/** host/slug/id -> siteId resolution table, seeded at boot from `sites`. */
const siteAliases = new Map<string, string>();
/** Opens a dedicated LISTEN connection (session pooler) for the platform live deposit feed. */
let listenConnect: (() => Promise<DepositListenClient>) | undefined;
/** Brand resolver: fast alias cache + (with a DB) a live lookup so brands onboarded AFTER boot
 *  resolve without a restart (GAP 2). Assigned in both the Pg and in-memory branches below. */
let resolver: SiteResolver;

if (usingDb) {
  const { Pool } = await import("pg");
  // Split pools (docs/25 Phase 5): all queries via the TRANSACTION pooler (:6543, high ceiling);
  // per-brand LISTEN connections via the SESSION pooler (:5432, required for NOTIFY). This stops the
  // engine from starving the scarce session pool under load while keeping live config hot-reload.
  const { queryPool, listenPool } = makePgPools(Pool, (m) => console.log(`[engine] ${m}`));
  listenConnect = () => listenPool.connect() as unknown as Promise<DepositListenClient>;
  const pool = queryPool;
  const q = pool as unknown as Querier;
  platformGate = new PlatformGate((sql: string, p?: unknown[]) => q.query(sql, p ?? []));
  repo = new PgGameRepository(q);
  overridesRepo = new PgUserOverridesRepository(q);

  // Resolve aliases (slug + primary_domain -> id) for active brands so a connection can name its
  // site by slug or host, not just uuid.
  const rows = (await q.query(
    "select id, slug, primary_domain, master_seed_ref, pool_mode from sites where status = 'active'", [])).rows;
  const masterRefBySite = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.id);
    siteAliases.set(id, id);
    if (r.slug) siteAliases.set(String(r.slug), id);
    if (r.primary_domain) siteAliases.set(String(r.primary_domain), id);
    if (r.master_seed_ref && process.env[String(r.master_seed_ref)]) masterRefBySite.set(id, process.env[String(r.master_seed_ref)]!);
  }
  masterSeedFor = (siteId) => masterRefBySite.get(siteId);
  poolController = new PoolController(new PgPoolRepo(q));
  // Live pool_mode: LISTEN sites_changed (migration 0088) + poll fallback, so toggles / new brands
  // apply without a redeploy. Uses the session pooler for LISTEN, like the per-brand config stores.
  sitesStore = new SitesStore(q, {
    connect: () => listenPool.connect() as unknown as Promise<ListenClient>,
    onChange: (siteId, poolMode) => console.log(`[engine] pool_mode ${siteId} -> ${poolMode} (live; no redeploy)`),
    onError: (err, ctx) => console.error(`[engine] sites ${ctx}:`, err.message),
  });
  await sitesStore.init();
  console.log(`[engine] pool controller ready; pool_mode brands: ${sitesStore.poolModeBrandCount()} (live)`);

  // Canonical "is this a demo/marketer account?" (migration 0084: fn_is_marketer_account). One source
  // of truth for the pool exemption AND the money layer's demo routing, so they can never diverge. A
  // short TTL cache keeps it off the trade hot path (marketer status changes rarely).
  const marketerCache = new Map<string, { v: boolean; exp: number }>();
  loadIsMarketer = async (userId: string): Promise<boolean> => {
    const now = Date.now();
    const hit = marketerCache.get(userId);
    if (hit && hit.exp > now) return hit.v;
    try {
      const r = await q.query("select fn_is_marketer_account($1) as m", [userId]);
      const v = r.rows[0]?.m === true;
      marketerCache.set(userId, { v, exp: now + 60_000 });
      return v;
    } catch {
      // On a lookup failure, DON'T treat a real player as a marketer (fail toward the real path, which
      // the DB RPC still guards); and don't cache the miss.
      return hit?.v ?? false;
    }
  };

  // Each brand gets its own live store: LISTEN site_game_config_changed (filtered to the brand's
  // payload) + a poll fallback, with historical versions resolved from site_game_config_versions.
  // A dedicated LISTEN connection per brand is opened lazily via pool.connect().
  configFor = async (siteId): Promise<ConfigProvider> => {
    const store = new SiteGameConfigStore(siteId, q, {
      connect: () => listenPool.connect() as unknown as Promise<ListenClient>,
    });
    await store.init();
    return store;
  };
  // Live resolution for a brand ONBOARDED AFTER boot (GAP 2): on an alias miss, look the ref up in
  // `sites` (active only) by slug/domain/id. On a hit we also pick up that brand's dedicated master
  // seed if its env var is present (else the shared platform seed, decorrelated per site_id). The
  // SiteResolver caches the hit (and short-negative-caches misses), so this runs once per new brand.
  const liveLookup: SiteLookup = async (ref) => {
    const r = await q.query(
      `select id, master_seed_ref from sites
        where status = 'active'
          and (lower(slug) = $1
               or lower(primary_domain) = $1
               or regexp_replace(lower(primary_domain), '^www\\.', '') = $1
               or lower(id::text) = $1)
        limit 1`,
      [ref],
    );
    if (!r.rows.length) return null;
    const row = r.rows[0] as { id: string; master_seed_ref: string | null };
    const id = String(row.id);
    const seedRef = row.master_seed_ref ? String(row.master_seed_ref) : "";
    if (seedRef && process.env[seedRef]) masterRefBySite.set(id, process.env[seedRef]!);
    return id;
  };
  resolver = new SiteResolver({ aliases: siteAliases, lookup: liveLookup });
  console.log(`[engine] multi-tenant: ${siteAliases.size} alias(es) for active brands; store=postgres (live brand resolution on)`);
} else {
  const mem = new InMemoryGameRepository();
  repo = mem;
  siteAliases.set(DEFAULT_SITE, DEFAULT_SITE);
  siteAliases.set("default", DEFAULT_SITE);
  configFor = () => new StaticConfigProvider(DEFAULT_VERSIONED_CONFIG);
  resolver = new SiteResolver({ aliases: siteAliases }); // no live lookup in dev — a miss stays a miss
  console.log("[engine] no DATABASE_URL — in-memory single default brand (dev)");
}

const registry = new SiteRegistry({
  masterSeed: MASTER_SEED,
  repo,
  configFor,
  ...(masterSeedFor ? { masterSeedFor } : {}),
  ...(overridesRepo ? { loadOverride: (uid: string) => overridesRepo!.getForUser(uid) } : {}),
  ...(poolController ? { poolController, poolModeFor: (siteId: string) => sitesStore!.poolModeFor(siteId) } : {}),
  ...(loadIsMarketer ? { loadIsMarketer } : {}),
});

// Deterministic crash recovery across every brand with open positions, before accepting traffic.
const recovered = await registry.recoverAll();
for (const [siteId, rep] of recovered) {
  console.log(`[engine] recovery ${siteId}: scanned=${rep.scanned} settled=${rep.settled} rearmed=${rep.rearmed} noop=${rep.noop} failed=${rep.failed}`);
}

/** Resolve a connection's brand from `?site=` (slug|domain|id) then Host, then the default. Async
 *  because a brand onboarded after boot is resolved via a live `sites` lookup (GAP 2). */
async function resolveSite(req: IncomingMessage): Promise<string> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("site");
  const host = (req.headers["host"] ?? "").toString().split(":")[0]!;
  const id = (await resolver.resolve(q)) ?? (await resolver.resolve(host));
  if (id) return id;
  if (!usingDb) return DEFAULT_SITE;
  throw new Error(`unresolved site (site=${q ?? ""} host=${host})`);
}

const devSeed = !usingDb && repo instanceof InMemoryGameRepository
  ? async (_siteId: string, userId: string) => { if ((await repo.getBalance(userId)) === 0) (repo as InMemoryGameRepository).seed(userId, 100000); }
  : undefined;

const handle = await startMultiEngine({
  port: PORT,
  registry,
  repo,
  verifier,
  resolveSite,
  onlineFloor: ONLINE_FLOOR,
  ...(devSeed ? { devSeedBalance: devSeed } : {}),
  ...(platformGate ? { playAllowed: () => platformGate!.allows("play") } : {}),
});

if (!verifier) console.warn("[engine] WARNING: no JWT verifier — DEV auth (trusts client userId). Not for production.");
console.log(`[engine] multiplexed WS listening on :${PORT}  store=${usingDb ? "postgres" : "in-memory"}  auth=${verifier ? "jwt" : "dev"}  onlineFloor=${ONLINE_FLOOR}`);

// docs/24: platform live deposit feed. LISTEN `deposit_confirmed` (migration 0071) and fan each
// confirmed deposit out to connected platform_superadmin sockets. DB mode only.
if (listenConnect) {
  const depositNotifier = new DepositNotifier({
    connect: listenConnect,
    onDeposit: (dep) => handle.emitPlatformDeposit(dep),
    onError: (err, ctx) => console.error(`[engine] deposit-notify ${ctx}:`, err.message),
  });
  await depositNotifier.init();
  console.log("[engine] platform live deposit feed armed (LISTEN deposit_confirmed)");
}

// Rotate every brand's seed at the UTC day boundary (reveals yesterday, commits today per brand).
setInterval(() => {
  void (async () => {
    for (const rt of registry.all()) {
      try {
        const before = rt.seeds.getActive().dateKey;
        const { active, revealed } = await rt.seeds.rotate();
        if (active.dateKey !== before) console.log(`[engine] ${rt.siteId} rotated to ${active.dateKey}${revealed ? ` (revealed ${revealed})` : ""}`);
      } catch (err) { console.error(`[engine] ${rt.siteId} rotation:`, (err as Error).message); }
    }
  })();
}, 60_000).unref();

process.on("SIGTERM", () => { void handle.close().then(() => process.exit(0)); });
