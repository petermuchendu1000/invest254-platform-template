/**
 * schema_drift.mts — does production's schema match what the migrations build? (DRIFT-1, BUGLOG #57)
 *
 * On 2026-09-23 production was found to carry an out-of-band script that added a feature and silently
 * rolled back brand hardening; the migration ledger could not see it (it only checks WHICH files ran,
 * not what the schema IS). This compares the live catalog with a REFERENCE database built from the
 * shim + every migration, object by object: public function bodies, EXECUTE grants to anon /
 * authenticated, policies, indexes, views (+ options), columns and table write-grants.
 *
 *   DATABASE_URL=<production> REFERENCE_DATABASE_URL=<empty scratch db> \
 *     node --import tsx scripts/schema_drift.mts --build-reference
 *
 * Exit 0 = no drift, 1 = drift (the report lists every object), 2 = misconfiguration.
 * Extension-owned objects (pgcrypto, pgvector, …) are excluded: Supabase installs them in another
 * schema/version. KNOWN_DIFFERENCES lists the few platform-provided objects that legitimately differ.
 */
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "packages", "db", "migrations");
const SHIM = join(ROOT, "packages", "db", "_testkit", "00_supabase_shim.sql");

/** Objects that legitimately exist on only one side. Keep this list short and justified. */
export const KNOWN_DIFFERENCES: Record<string, string> = {
  "function:rls_auto_enable()": "Supabase-provided event-trigger helper (production only)",
  "function:gen_random_uuid()": "provided by the local test shim; Supabase ships it in pg_catalog",
};

const NOT_EXT = (col: string) => `not exists (select 1 from pg_depend d where d.objid = ${col} and d.deptype = 'e')`;
export const CATALOG: Record<string, string> = {
  function: `select p.oid::regprocedure::text as k, md5(pg_get_functiondef(p.oid)) as v
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and ${NOT_EXT("p.oid")}`,
  "function-exec": `select p.oid::regprocedure::text as k,
               (has_function_privilege('anon', p.oid, 'EXECUTE'))::text || '/' || (has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text as v
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and ${NOT_EXT("p.oid")}`,
  policy: `select tablename || '.' || policyname as k, md5(coalesce(qual,'') || '|' || coalesce(with_check,'') || '|' || cmd || '|' || array_to_string(roles, ',')) as v
             from pg_policies where schemaname = 'public'`,
  index: `select indexname as k, md5(indexdef) as v from pg_indexes where schemaname = 'public'`,
  view: `select c.relname as k, md5(pg_get_viewdef(c.oid) || coalesce(array_to_string(c.reloptions, ','), '')) as v
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m') and ${NOT_EXT("c.oid")}`,
  column: `select table_name || '.' || column_name as k, data_type || coalesce('(' || character_maximum_length || ')', '') as v
             from information_schema.columns where table_schema = 'public'`,
  "table-write-grant": `select table_name || ':' || grantee as k, string_agg(privilege_type, ',' order by privilege_type) as v
             from information_schema.role_table_grants
            where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
            group by table_name, grantee`,
};

export type Snapshot = Record<string, Record<string, string>>;
export interface DriftItem { kind: string; key: string; change: "only-production" | "only-migrations" | "differs" }

/** Pure: every object that differs between production and the migrations-built reference. */
export function diffSnapshots(prod: Snapshot, ref: Snapshot, known: Record<string, string> = KNOWN_DIFFERENCES): DriftItem[] {
  const out: DriftItem[] = [];
  for (const kind of Object.keys(CATALOG)) {
    const p = prod[kind] ?? {}, r = ref[kind] ?? {};
    const allowed = (k: string) => `${kind === "function-exec" ? "function" : kind}:${k}` in known;
    for (const k of Object.keys(p)) if (!(k in r) && !allowed(k)) out.push({ kind, key: k, change: "only-production" });
    for (const k of Object.keys(r)) if (!(k in p) && !allowed(k)) out.push({ kind, key: k, change: "only-migrations" });
    for (const k of Object.keys(p)) if (k in r && p[k] !== r[k] && !allowed(k)) out.push({ kind, key: k, change: "differs" });
  }
  return out.sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key));
}

async function snapshot(client: pg.Client): Promise<Snapshot> {
  const snap: Snapshot = {};
  for (const [kind, sql] of Object.entries(CATALOG)) {
    const { rows } = await client.query<{ k: string; v: string }>(sql);
    snap[kind] = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }
  return snap;
}

/** Build the reference: shim, Supabase-like default privileges, then every migration in order. */
async function buildReference(client: pg.Client): Promise<void> {
  await client.query(readFileSync(SHIM, "utf8"));
  await client.query(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
                      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
                      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
  for (const f of readdirSync(MIG_DIR).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    await client.query(readFileSync(join(MIG_DIR, f), "utf8"));
  }
}

async function main(): Promise<void> {
  const prodUrl = process.env.DATABASE_URL, refUrl = process.env.REFERENCE_DATABASE_URL;
  if (!prodUrl || !refUrl) { console.error("DATABASE_URL and REFERENCE_DATABASE_URL are required"); process.exit(2); }
  const prod = new pg.Client({ connectionString: prodUrl }), ref = new pg.Client({ connectionString: refUrl });
  await prod.connect(); await ref.connect();
  try {
    if (process.argv.includes("--build-reference")) await buildReference(ref);
    const items = diffSnapshots(await snapshot(prod), await snapshot(ref));
    if (!items.length) { console.log("schema-drift: OK — production matches the migrations"); return; }
    console.log(`schema-drift: ${items.length} difference(s) between production and the migrations:`);
    for (const i of items) console.log(`  ${i.change.padEnd(16)} ${i.kind.padEnd(18)} ${i.key}`);
    process.exitCode = 1;
  } finally { await prod.end(); await ref.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("schema-drift failed:", (e as Error).message); process.exit(2); });
}
