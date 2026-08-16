/**
 * pgpools.ts — split Postgres connection pools for the Supabase pooler (docs/25 Phase 5).
 *
 * Supabase exposes the same `*.pooler.supabase.com` host in two modes:
 *   - SESSION pooler  (port 5432): a client keeps one server connection for the whole session.
 *     Required for LISTEN/NOTIFY (the durable notification channel). Scarce — the session pool has
 *     a low client ceiling, so holding one connection per brand for LISTEN quickly starves it.
 *   - TRANSACTION pooler (port 6543): a server connection is borrowed per statement and returned
 *     immediately. Huge connection ceiling, ideal for the short autonomous RPC/queries the engine
 *     and API run. Does NOT support session features (LISTEN/NOTIFY, session GUCs, cross-statement
 *     transactions on the same client) — which is fine here: every query is a single statement/RPC.
 *
 * So we run TWO pools:
 *   - queryPool  -> transaction pooler (:6543), bounded `max`, for all `q.query()` traffic.
 *   - listenPool -> session pooler   (:5432), tiny, ONLY for LISTEN connections (one per brand).
 *
 * URLs are derived from DATABASE_URL (assumed session/5432) unless explicitly overridden by
 * QUERY_DATABASE_URL / LISTEN_DATABASE_URL. If DATABASE_URL is a direct (non-pooler) connection,
 * we leave the query URL as-is (no safe transaction-pooler port to infer).
 */
import type { Pool as PgPool } from "pg";

/** Swap a Supabase SESSION-pooler URL (:5432) to the TRANSACTION pooler (:6543). No-op otherwise. */
export function toTransactionPooler(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("pooler.supabase.com")) {
      u.port = "6543";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export interface PgPools {
  /** Transaction-pooler pool for all query/RPC traffic. Use this as the `Querier`. */
  queryPool: PgPool;
  /** Session-pooler pool for LISTEN connections only (one long-lived conn per brand). */
  listenPool: PgPool;
}

/**
 * Build the two pools from the environment. `Pool` is injected so callers use their own `pg` import
 * (the engine/api dynamically import "pg"). Errors are logged, not thrown, so a dropped backend
 * connection never crashes the process.
 */
export function makePgPools(Pool: typeof PgPool, log: (msg: string) => void = () => {}): PgPools {
  const listenUrl = process.env.LISTEN_DATABASE_URL ?? process.env.DATABASE_URL!;
  const queryUrl = process.env.QUERY_DATABASE_URL ?? toTransactionPooler(listenUrl);

  const queryPool = new Pool({
    connectionString: queryUrl,
    max: Number(process.env.PG_QUERY_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
  });
  const listenPool = new Pool({
    connectionString: listenUrl,
    max: Number(process.env.PG_LISTEN_POOL_MAX ?? 4),
    idleTimeoutMillis: 0, // never reap a LISTEN connection
    connectionTimeoutMillis: 10_000,
  });

  queryPool.on("error", (e: Error) => log(`queryPool error: ${e.message}`));
  listenPool.on("error", (e: Error) => log(`listenPool error: ${e.message}`));

  const mode = queryUrl === listenUrl ? "single (no transaction pooler inferred)" : "split (query=6543 / listen=5432)";
  log(`pg pools: ${mode}; query max=${queryPool.options.max}, listen max=${listenPool.options.max}`);
  return { queryPool, listenPool };
}
