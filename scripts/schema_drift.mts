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
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
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
export interface DriftItem {
  kind: string;
  key: string;
  change: "only-production" | "only-migrations" | "differs";
  /**
   * The catalog VALUE on each side, where one exists.
   *
   * Carried because "only-production column profiles.display_currency" tells you an orphan exists but
   * not what it IS, and you cannot write the migration that adopts it without its type. Rendered only
   * for the kinds whose value is readable — see READABLE_VALUE; the rest are md5 digests, which add
   * nothing to a report.
   */
  prod?: string;
  ref?: string;
}

/** Catalog kinds whose value is a fact rather than an md5 of a definition. */
export const READABLE_VALUE = new Set(["column", "function-exec", "table-write-grant"]);

/** Pure: every object that differs between production and the migrations-built reference. */
export function diffSnapshots(prod: Snapshot, ref: Snapshot, known: Record<string, string> = KNOWN_DIFFERENCES): DriftItem[] {
  const out: DriftItem[] = [];
  for (const kind of Object.keys(CATALOG)) {
    const p = prod[kind] ?? {}, r = ref[kind] ?? {};
    const allowed = (k: string) => `${kind === "function-exec" ? "function" : kind}:${k}` in known;
    for (const k of Object.keys(p)) if (!(k in r) && !allowed(k)) out.push({ kind, key: k, change: "only-production", prod: p[k]! });
    for (const k of Object.keys(r)) if (!(k in p) && !allowed(k)) out.push({ kind, key: k, change: "only-migrations", ref: r[k]! });
    for (const k of Object.keys(p)) if (k in r && p[k] !== r[k] && !allowed(k)) out.push({ kind, key: k, change: "differs", prod: p[k]!, ref: r[k]! });
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

/**
 * Put the report where it can actually be READ.
 *
 * It used to go to console.log alone, which meant a red X on the run page and nothing else: to learn
 * what had drifted you had to open the raw log, and a tool that cannot reach the log storage host
 * (or a person skimming a PR) learned nothing at all. This job sat red for a week on exactly that.
 *
 * So the report is emitted three ways: the log, a GitHub job summary (the run page's own panel), and
 * ONE error annotation carrying the whole thing. The annotation matters most — it is the only one of
 * the three available through the REST API, so `check-runs/<id>/annotations` now answers "what
 * drifted?" without log access. One annotation rather than one per item because GitHub shows at most
 * ten per step, and a truncated drift report is a misleading drift report.
 */
export function publishReport(items: DriftItem[]): void {
  const detail = (i: DriftItem): string => {
    if (!READABLE_VALUE.has(i.kind)) return "";
    const parts = [i.prod === undefined ? "" : `prod=${i.prod}`, i.ref === undefined ? "" : `migrations=${i.ref}`].filter(Boolean);
    return parts.length ? `  [${parts.join(" ")}]` : "";
  };
  const lines = items.map((i) => `${i.change.padEnd(16)} ${i.kind.padEnd(18)} ${i.key}${detail(i)}`);
  for (const l of lines) console.log(`  ${l}`);
  if (!process.env.GITHUB_ACTIONS) return;

  const byKind = new Map<string, number>();
  for (const i of items) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  const tally = [...byKind].sort().map(([k, n]) => `${k}=${n}`).join(" ");

  // Annotations are size-capped; a very wide drift is summarised rather than truncated silently.
  const MAX = 60;
  const shown = lines.slice(0, MAX);
  const extra = lines.length > MAX ? `\n… and ${lines.length - MAX} more (full list in the step log)` : "";
  const body = `${items.length} difference(s) between production and the migrations — ${tally}\n${shown.join("\n")}${extra}`;
  // %0A is how a workflow command carries a newline; %25/%0D must be escaped with it.
  const esc = (t: string) => t.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::error title=Schema drift (${items.length})::${esc(body)}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const md = [
      `### Schema drift: ${items.length} difference(s)`,
      "",
      `\`${tally}\``,
      "",
      "| change | kind | object | value |",
      "| --- | --- | --- | --- |",
      ...items.map((i) => `| ${i.change} | ${i.kind} | \`${i.key.replace(/\|/g, "\\|")}\` |${detail(i) ? ` ${detail(i).trim()} |` : " |"}`),
      "",
      "`only-production` = something exists in the database that no migration builds (the out-of-band",
      "change this gate exists to catch). `only-migrations` = a migration was recorded but its object is",
      "missing. `differs` = same name, different definition.",
    ].join("\n");
    try { appendFileSync(summary, `${md}\n`); } catch { /* summary unavailable — the annotation carries it */ }
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
    publishReport(items);
    process.exitCode = 1;
  } finally { await prod.end(); await ref.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("schema-drift failed:", (e as Error).message); process.exit(2); });
}
