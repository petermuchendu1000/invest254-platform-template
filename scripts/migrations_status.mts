/**
 * migrations_status.mts — reconcile the migrations/ directory against the DB ledger (0091).
 *
 * Gives git + the database the tooling to TRACK CHANGES OVER TIME and REBUILD deterministically:
 *   - default (report): prints, for every migration file and every ledger row, one of
 *       APPLIED (checksum matches) | CHANGED (file edited since apply!) | UNRECORDED (file not in
 *       ledger) | MISSING_FILE (ledger row has no file) — and exits non-zero if anything is wrong.
 *   - --record: upsert a ledger row for every migration file (filename + sha256), stamping it
 *       applied. Use to BACKFILL and after applying each new migration.
 *
 * Read-only unless --record. Uses DATABASE_URL (Supabase session-pooler :5432).
 * Run:  DATABASE_URL=... node --import tsx scripts/migrations_status.mts [--record]
 */
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "migrations");
const RECORD = process.argv.includes("--record");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function repoMigrations(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort())
    m.set(f, sha256(readFileSync(join(MIG_DIR, f))));
  return m;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const pool = new Pool({ connectionString: url, max: 3 });
  const files = repoMigrations();

  if (RECORD) {
    let n = 0;
    for (const [filename, checksum] of files) {
      await pool.query(
        `insert into public.schema_migrations(filename, checksum) values ($1,$2)
           on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()`,
        [filename, checksum]);
      n++;
    }
    console.log(`recorded ${n} migration(s) into public.schema_migrations`);
  }

  const { rows } = await pool.query<{ filename: string; checksum: string; applied_at: string }>(
    "select filename, checksum, applied_at from public.schema_migrations");
  const ledger = new Map(rows.map((r) => [r.filename, r.checksum]));

  let problems = 0;
  const line = (state: string, f: string, extra = "") => console.log(`  ${state.padEnd(11)} ${f}${extra}`);
  for (const [f, cs] of files) {
    if (!ledger.has(f)) { line("UNRECORDED", f, "  (file present, not in ledger)"); problems++; }
    else if (ledger.get(f) !== cs) { line("CHANGED", f, "  (file checksum != ledger checksum — edited after apply!)"); problems++; }
    else line("APPLIED", f);
  }
  for (const f of ledger.keys())
    if (!files.has(f)) { line("MISSING_FILE", f, "  (ledger row has no matching file)"); problems++; }

  console.log(`\n${files.size} migration files, ${ledger.size} ledger rows, ${problems} problem(s).`);
  await pool.end();
  process.exitCode = problems === 0 ? 0 : 1;
}
main().catch((e) => { console.error("migrations_status failed:", e); process.exit(2); });
