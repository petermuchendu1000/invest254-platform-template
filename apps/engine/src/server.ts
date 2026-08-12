import { type IncomingMessage } from "node:http";
import {
  InMemoryGameRepository, PgGameRepository, type GameRepository, type Querier,
} from "./wallet.js";
import { StaticConfigProvider, SiteGameConfigStore, type ConfigProvider, type ListenClient } from "./gameconfig.js";
import { PgUserOverridesRepository, type UserOverridesRepository } from "./overrides.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine } from "./multiengine.js";
import { makeVerifier } from "./auth.js";
import { DEFAULT_VERSIONED_CONFIG } from "@invest254/shared";

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
let overridesRepo: UserOverridesRepository | undefined;
let configFor: (siteId: string) => ConfigProvider | Promise<ConfigProvider>;
let masterSeedFor: ((siteId: string) => string | undefined) | undefined;
/** host/slug/id -> siteId resolution table, refreshed at boot from `sites`. */
const siteAliases = new Map<string, string>();

if (usingDb) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = pool as unknown as Querier;
  repo = new PgGameRepository(q);
  overridesRepo = new PgUserOverridesRepository(q);

  // Resolve aliases (slug + primary_domain -> id) for active brands so a connection can name its
  // site by slug or host, not just uuid.
  const rows = (await q.query(
    "select id, slug, primary_domain, master_seed_ref from sites where status = 'active'", [])).rows;
  const masterRefBySite = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.id);
    siteAliases.set(id, id);
    if (r.slug) siteAliases.set(String(r.slug), id);
    if (r.primary_domain) siteAliases.set(String(r.primary_domain), id);
    if (r.master_seed_ref && process.env[String(r.master_seed_ref)]) masterRefBySite.set(id, process.env[String(r.master_seed_ref)]!);
  }
  masterSeedFor = (siteId) => masterRefBySite.get(siteId);

  // Each brand gets its own live store: LISTEN site_game_config_changed (filtered to the brand's
  // payload) + a poll fallback, with historical versions resolved from site_game_config_versions.
  // A dedicated LISTEN connection per brand is opened lazily via pool.connect().
  configFor = async (siteId): Promise<ConfigProvider> => {
    const store = new SiteGameConfigStore(siteId, q, {
      connect: () => pool.connect() as unknown as Promise<ListenClient>,
    });
    await store.init();
    return store;
  };
  console.log(`[engine] multi-tenant: ${siteAliases.size} alias(es) for active brands; store=postgres`);
} else {
  const mem = new InMemoryGameRepository();
  repo = mem;
  siteAliases.set(DEFAULT_SITE, DEFAULT_SITE);
  siteAliases.set("default", DEFAULT_SITE);
  configFor = () => new StaticConfigProvider(DEFAULT_VERSIONED_CONFIG);
  console.log("[engine] no DATABASE_URL — in-memory single default brand (dev)");
}

const registry = new SiteRegistry({
  masterSeed: MASTER_SEED,
  repo,
  configFor,
  ...(masterSeedFor ? { masterSeedFor } : {}),
  ...(overridesRepo ? { loadOverride: (uid: string) => overridesRepo!.getForUser(uid) } : {}),
});

// Deterministic crash recovery across every brand with open positions, before accepting traffic.
const recovered = await registry.recoverAll();
for (const [siteId, rep] of recovered) {
  console.log(`[engine] recovery ${siteId}: scanned=${rep.scanned} settled=${rep.settled} rearmed=${rep.rearmed} noop=${rep.noop} failed=${rep.failed}`);
}

/** Resolve a connection's brand from `?site=` (slug|domain|id) then Host, then the default. */
function resolveSite(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("site");
  if (q && siteAliases.has(q)) return siteAliases.get(q)!;
  const host = (req.headers["host"] ?? "").toString().split(":")[0]!;
  if (host && siteAliases.has(host)) return siteAliases.get(host)!;
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
});

if (!verifier) console.warn("[engine] WARNING: no JWT verifier — DEV auth (trusts client userId). Not for production.");
console.log(`[engine] multiplexed WS listening on :${PORT}  store=${usingDb ? "postgres" : "in-memory"}  auth=${verifier ? "jwt" : "dev"}  onlineFloor=${ONLINE_FLOOR}`);

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
