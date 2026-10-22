import { makeDemoAccountResolver } from "./demoresolver.js";
import { type IncomingMessage } from "node:http";
import {
  InMemoryGameRepository, PgGameRepository, type GameRepository, type Querier,
} from "./wallet.js";
import { StaticConfigProvider, SiteGameConfigStore, type ConfigProvider, type ListenClient } from "./gameconfig.js";
import { SitesStore } from "./sitesstore.js";
import { PgUserOverridesRepository, type UserOverridesRepository } from "./overrides.js";
import { composeGlobalOverride } from "./globaloverride.js";
import { PoolController, PgPoolRepo } from "./poolcontroller.js";
import { makePgPools } from "./pgpools.js";
import { SiteRegistry } from "./siteregistry.js";
import { SiteResolver, type SiteLookup } from "./siteresolver.js";
import { startMultiEngine } from "./multiengine.js";
import { DepositNotifier, type DepositListenClient } from "./platformlive.js";
import { PgPlatformRepository } from "./platform.js";
import { PoolRealtimeDistributor } from "./poolrealtime.js";
import { makeVerifier } from "./auth.js";
import { makeSystemLogPersister } from "./systemlog.js";
import { SharedSiteConfigListener } from "./siteconfiglisten.js";
import {
  DEFAULT_VERSIONED_CONFIG, PlatformGate, chartStyleOf, curveProfileForChartStyle,
  defaultConfigForProfile, TERMINAL_VERSIONED_CONFIG, type CurveProfile, type VersionedGameConfig,
} from "@invest254/shared";

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

/**
 * Local-dev-only master seed, used ONLY when DATABASE_URL is unset (in-memory dev). Named so that
 * if it ever shows up in a reveal/commitment audit it is self-evidently not a production secret.
 */
const DEV_ONLY_MASTER_SEED = "INSECURE-LOCAL-DEV-ONLY-MASTER-SEED-NOT-PRODUCTION-SAFE";
/** The seed literal that used to be the committed fallback here — anyone with the repo knows it. */
const LEAKED_MASTER_SEED = "dev-master-seed-0001";
/**
 * Minimum accepted master-seed length. `openssl rand -hex 32` (the documented generator, see
 * .env.example) emits 64 hex chars; 32 chars is the floor at which a hex or base64 secret still
 * carries roughly 128 bits, i.e. is beyond offline search. Anything shorter is a placeholder or a
 * passphrase, and the master seed is not a password: it is the HMAC key behind EVERY brand's daily
 * seed (packages/shared/src/seed.ts, packages/shared/src/site.ts), so guessing it yields every
 * future trade outcome and lets any published fairness commitment be forged after the fact.
 */
const MIN_MASTER_SEED_LENGTH = 32;

/**
 * Resolve the platform master seed, failing CLOSED on a real deployment.
 *
 * The previous committed fallback meant a deployment that forgot MASTER_SEED/SERVER_SEED silently
 * derived every daily seed from a value published in this repository — predictable outcomes and
 * forgeable commitments, with nothing in the logs to say so. DATABASE_URL is the same "this is a
 * real deployment" signal already used for the JWT verifier a few lines below, so the two
 * fail-closed checks agree.
 *
 * NEVER log the seed, a prefix of it, or its length: the error names the variable only, because a
 * boot error is the one message that reliably reaches shared logs, dashboards and support threads.
 */
function resolveMasterSeed(): string {
  const configured = process.env.MASTER_SEED ?? process.env.SERVER_SEED;
  // In-memory dev (no DATABASE_URL): no real money, no published commitments — keep booting.
  if (!process.env.DATABASE_URL) return configured ?? DEV_ONLY_MASTER_SEED;
  const hint = "Generate one with `openssl rand -hex 32` and set MASTER_SEED (SERVER_SEED is the legacy fallback).";
  const why = "It is the HMAC key for every brand's daily seed, so it determines every trade outcome and every published fairness commitment: a known or guessable value makes outcomes predictable and commitments forgeable.";
  if (!configured) {
    throw new Error(`SEED: MASTER_SEED is required when DATABASE_URL is set. ${hint} ${why}`);
  }
  const value = configured.trim();
  if (value === LEAKED_MASTER_SEED || value === DEV_ONLY_MASTER_SEED) {
    throw new Error(`SEED: MASTER_SEED is set to a development placeholder that is committed to this repository, so it is public. ${hint} ${why}`);
  }
  if (value.length < MIN_MASTER_SEED_LENGTH) {
    throw new Error(`SEED: MASTER_SEED is too short to be a secret (minimum ${MIN_MASTER_SEED_LENGTH} characters). ${hint} ${why}`);
  }
  return configured;
}

const MASTER_SEED = resolveMasterSeed();

/**
 * The PREVIOUS master seed, if the platform has rotated. Used only to reveal days committed under
 * it — see SeedManagerOptions.legacyMasterSeed for why rotation is otherwise a one-way door that
 * permanently orphans every open day.
 *
 * Deliberately NOT subjected to the fail-closed checks above. The leaked literal is a legitimate
 * value here: it is precisely what the already-committed days were derived from, and the whole
 * point is to be able to open them. It can never produce a new commitment, so a public value in
 * this variable cannot make any future outcome predictable.
 */
const LEGACY_MASTER_SEED = process.env.MASTER_SEED_LEGACY ?? process.env.SERVER_SEED_LEGACY;
if (LEGACY_MASTER_SEED) {
  console.log("[engine] legacy master seed configured: days committed before the rotation remain revealable");
}

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
// Price-curve shape per brand from sites.chart_style (line ⇒ irregular waves, else trending market).
let curveProfileFor: ((siteId: string) => Promise<CurveProfile>) | undefined;
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
/** Module-scope query handle (transaction pooler) for the real-time pool reallocator. DB mode only. */
let realtimeQuery: Querier | undefined;
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
  realtimeQuery = q;
  // Owner-visible System logs (docs/36, BUGLOG #34): the engine has no structured logger — its boot,
  // crash-recovery, seed-rotation, pool and payments/Daraja/MegaPay events are all console.*. Capture
  // them (tagged app='engine') so the System logs UI shows the WHOLE system, not just the API.
  makeSystemLogPersister(pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }> }, { app: "engine" }).captureConsole();
  platformGate = new PlatformGate((sql: string, p?: unknown[]) => q.query(sql, p ?? []));
  repo = new PgGameRepository(q);
  overridesRepo = new PgUserOverridesRepository(q);

  // Resolve aliases (slug + primary_domain -> id) for active brands so a connection can name its
  // site by slug or host, not just uuid.
  const rows = (await q.query(
    "select id, slug, primary_domain, master_seed_ref, pool_mode, chart_style from sites where status = 'active'", [])).rows;
  const masterRefBySite = new Map<string, string>();
  // Price shape per brand, derived from chart_style. Seeded at boot; a brand onboarded AFTER boot
  // (GAP 2) is looked up live and cached on first use, so it prices under its own shape too.
  const curveProfileBySite = new Map<string, CurveProfile>();
  for (const r of rows) {
    const id = String(r.id);
    siteAliases.set(id, id);
    if (r.slug) siteAliases.set(String(r.slug), id);
    if (r.primary_domain) siteAliases.set(String(r.primary_domain), id);
    if (r.master_seed_ref && process.env[String(r.master_seed_ref)]) masterRefBySite.set(id, process.env[String(r.master_seed_ref)]!);
    curveProfileBySite.set(id, curveProfileForChartStyle(chartStyleOf(r.chart_style)));
  }
  masterSeedFor = (siteId) => masterRefBySite.get(siteId);
  curveProfileFor = async (siteId) => {
    const cached = curveProfileBySite.get(siteId);
    if (cached) return cached;
    const r = (await q.query("select chart_style from sites where id = $1 limit 1", [siteId])).rows[0] as { chart_style?: unknown } | undefined;
    const profile = curveProfileForChartStyle(chartStyleOf(r?.chart_style));
    curveProfileBySite.set(siteId, profile);
    return profile;
  };
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

  // ONE shared LISTEN connection on the GLOBAL site_game_config_changed channel, fanned out to every
  // brand's config store — instead of a dedicated session-pooler connection per brand, which starved
  // the tiny listen pool once brand count exceeded PG_LISTEN_POOL_MAX (BUGLOG #35). Per-brand stores
  // stay poll-only as the safety net, so a dropped shared connection degrades to polling, not silence.
  const siteConfigListener = new SharedSiteConfigListener({
    connect: () => listenPool.connect() as unknown as Promise<ListenClient>,
    onError: (err, ctx) => console.error(`[engine] site-config ${ctx}:`, err.message),
  });

  // Canonical "is this a demo/marketer account?" (migration 0084: fn_is_marketer_account). One source
  // of truth for the pool exemption AND the money layer's demo routing, so they can never diverge. A
  // short TTL cache keeps it off the trade hot path (marketer status changes rarely).
  //
  // DEMO-1 (owner-authorised 2026-09-24): a PLAYER whose wallet is in demo mode (migration 0123) is a
  // demo account too — the money RPCs already debit demo_balance for them (fn_account_is_demo), so the
  // pool exemption must agree or demo trades would spend the REAL payout pool. Marketer status is
  // cached (rarely changes); the wallet's account mode is read fresh on every trade because a player
  // can switch it at any time (the API refuses a switch while a contract is open).
  loadIsMarketer = makeDemoAccountResolver(q);

  // Each brand gets its own live store: a poll fallback + INSTANT push via the ONE shared LISTEN
  // connection (siteConfigListener) — no per-brand session connection (BUGLOG #35). Historical
  // versions resolved from site_game_config_versions.
  configFor = async (siteId): Promise<ConfigProvider> => {
    // Brand DISPLAY currency drives the currency-native near-miss withdrawal line (docs/25 §16). Read
    // once per brand here; the store converts minWithdrawalNative → KES cents at the live FX rate.
    let currency = "KES";
    try {
      const cr = await q.query("select currency from sites where id = $1::uuid limit 1", [siteId]);
      if (cr.rows.length) currency = String((cr.rows[0] as Record<string, unknown>).currency ?? "KES");
    } catch { /* default KES → near-miss uses the legacy min_withdrawal */ }
    /**
     * The fallback economy follows the brand's CURVE, because the two are not interchangeable.
     *
     * A candlestick brand settles continuously, and a continuous position's value at open can never
     * exceed the RTP, so the step economy's 75% edge would open every position at a near-total loss
     * (see TERMINAL_CONFIG in shared/config.ts). A line brand keeps the step contract and its edge
     * untouched. This is only what the store holds until the brand's own row is read: an operator's
     * saved `site_game_config_versions` row always wins, so no live brand is repriced by it.
     */
    // Without a profile resolver there is no way to know which curve this brand charts, so it keeps
    // today's economy exactly: `wave` resolves to DEFAULT_CONFIG, which is the unchanged behaviour.
    const profile = curveProfileFor ? await curveProfileFor(siteId) : "wave";
    const fallback: VersionedGameConfig = { ...defaultConfigForProfile(profile), version: 0 };
    const store = new SiteGameConfigStore(siteId, q, { currency, fallback }); // poll-only; push comes from the shared listener
    await store.init();
    // Instant hot-reload without a per-brand connection: the shared listener nudges THIS brand's
    // refresh when site_game_config_changed fires with its site_id (payload).
    siteConfigListener.register(siteId, () => { void store.refresh().catch(() => { /* poll covers it */ }); });
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
  /**
   * The dev brand is a TERMINAL brand, so it gets the terminal economy.
   *
   * `SiteRegistry` defaults an unresolved curve profile to `market` (siteregistry.ts 107), which is
   * what this path leaves it as, so the in-memory brand charts candlesticks and settles its
   * positions continuously. Handing it DEFAULT_VERSIONED_CONFIG gave it the step economy's 75% edge,
   * which cannot price a continuous position: every position opened in local dev was worth about
   * 0.02x the instant it opened. See TERMINAL_CONFIG in shared/config.ts.
   */
  configFor = () => new StaticConfigProvider(TERMINAL_VERSIONED_CONFIG);
  resolver = new SiteResolver({ aliases: siteAliases }); // no live lookup in dev — a miss stays a miss
  console.log("[engine] no DATABASE_URL — in-memory single default brand (dev)");
}

const registry = new SiteRegistry({
  masterSeed: MASTER_SEED,
  repo,
  configFor,
  // Rotation support: days committed under the previous master stay revealable. Only ever read on
  // a reveal whose primary-seed attempt was refused by the stored commitment.
  ...(LEGACY_MASTER_SEED ? { seedManagerOpts: { legacyMasterSeed: LEGACY_MASTER_SEED } } : {}),
  ...(masterSeedFor ? { masterSeedFor } : {}),
  ...(curveProfileFor ? { curveProfileFor } : {}),
  // loadOverride: per-user overrides, COMPOSED with the platform-global cohort economy (0099) when the
  // gate + marketer classifier are present (DB mode). Global-enforced fields win over per-user; the
  // same composed loader is handed to the RecoveryService by SiteRegistry, so open + recovery agree.
  ...(overridesRepo
    ? {
        loadOverride:
          platformGate && loadIsMarketer
            ? composeGlobalOverride((uid: string) => overridesRepo!.getForUser(uid), platformGate, loadIsMarketer)
            : (uid: string) => overridesRepo!.getForUser(uid),
      }
    : {}),
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
  // docs/42 UI-5: a platform admin's console live feed is scoped to its platform's brands.
  ...(realtimeQuery ? { sitesOfPlatform: async (platformId: string) => {
    const r = await realtimeQuery!.query("select id from public.sites where platform_id = $1", [platformId]);
    return (r.rows as Array<{ id: unknown }>).map((x) => String(x.id));
  } } : {}),
});

if (!verifier) console.warn("[engine] WARNING: no JWT verifier — DEV auth (trusts client userId). Not for production.");
console.log(`[engine] multiplexed WS listening on :${PORT}  store=${usingDb ? "postgres" : "in-memory"}  auth=${verifier ? "jwt" : "dev"}  onlineFloor=${ONLINE_FLOOR}`);

// docs/24: platform live deposit feed. LISTEN `deposit_confirmed` (migration 0071) and fan each
// confirmed deposit out to connected platform_superadmin sockets. DB mode only.
if (listenConnect) {
  // docs/25 §15.1: real-time pool reallocation. Each confirmed deposit nudges the platform's
  // UNDISTRIBUTED reserve toward brands now under-served vs the water-fill ideal (never-clawback via
  // fn_pool_topup_today). Envelope-gated (inert until platform_global_config.global_daily_pool_cents
  // is set) and debounced so deposit bursts trigger at most one reallocation per interval.
  let poolRealtime: PoolRealtimeDistributor | undefined;
  if (realtimeQuery) {
    const rq = realtimeQuery;
    const actorId = (await rq.query(
      "select id from profiles where role='platform_superadmin' order by created_at limit 1", [])).rows[0]?.id as string | undefined;
    if (actorId) {
      const platformRepo = new PgPlatformRepository(rq);
      poolRealtime = new PoolRealtimeDistributor({
        loadInputs: async () => {
          const envRow = (await rq.query("select global_daily_pool_cents from platform_global_config where id", [])).rows[0];
          const envelopeCents = Number(envRow?.global_daily_pool_cents ?? 0);
          if (!(envelopeCents > 0)) return { envelopeCents: 0, rows: [] };
          const preview = await platformRepo.poolDemand({ totalCents: envelopeCents, lookbackDays: 14 });
          const committed = new Map<string, number>();
          for (const r of (await rq.query(
            "select site_id::text as site_id, amount_cents from withdrawal_pool where trade_day = fn_eat_day()", [])).rows) {
            committed.set(String(r.site_id), Number(r.amount_cents));
          }
          return {
            envelopeCents,
            rows: preview.rows.map((r) => ({ siteId: r.siteId, idealCents: r.suggestedCents, committedCents: committed.get(r.siteId) ?? 0 })),
          };
        },
        apply: async (grants) => {
          await rq.query("select public.fn_pool_topup_today($1,$2,$3)", [
            actorId, "platform_superadmin",
            JSON.stringify(grants.map((g) => ({ site_id: g.siteId, amount_cents: g.amountCents }))),
          ]);
        },
        onApplied: (grants) => {
          const n = grants.filter((g) => g.grantCents > 0).length;
          if (n > 0) console.log(`[engine] pool realtime: topped up ${n} brand(s) from reserve`);
        },
        onError: (err) => console.error("[engine] pool realtime:", err.message),
      });
      // Periodic backstop: converge even when deposits are sparse (and cover a missed LISTEN event).
      setInterval(() => poolRealtime!.trigger(), 5 * 60_000).unref();
      poolRealtime.trigger(); // initial pass at boot
      console.log("[engine] real-time pool reallocation armed (envelope-gated)");
    } else {
      console.warn("[engine] real-time pool reallocation NOT armed — no platform_superadmin actor found");
    }
  }

  const depositNotifier = new DepositNotifier({
    connect: listenConnect,
    onDeposit: (dep) => { handle.emitPlatformDeposit(dep); poolRealtime?.trigger(); },
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
