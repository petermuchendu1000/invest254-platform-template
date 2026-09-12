/**
 * migrate.mts — apply every not-yet-recorded migration to the target DB AND record it in the same
 * transaction, so the applied-ledger (public.schema_migrations, 0091) can NEVER silently drift from
 * what is actually applied. This is the write-side companion to migrations_status.mts (the read-only
 * gate). Wire it into the deploy pipeline BEFORE `fly deploy` so prod schema is always current before
 * new code boots (BUGLOG #24: 0118's code shipped while its SQL was never applied → runtime errors).
 *
 * Behaviour (deterministic, filename order):
 *   - UNRECORDED (file not in ledger)      -> BEGIN; run the file; INSERT the ledger row; COMMIT.
 *                                             apply+record are atomic: a crash leaves neither.
 *   - APPLIED    (in ledger, checksum ==)  -> skip (idempotent no-op).
 *   - CHANGED    (in ledger, checksum !=)  -> STOP with a non-zero exit. Editing an applied migration
 *                                             is disallowed; fix by adding a NEW migration. (Never
 *                                             silently re-applies an edited file.)
 * All migrations in this repo are transaction-safe (no CONCURRENTLY/VACUUM) and idempotent, so
 * wrapping each file in one transaction is safe. Re-running is a no-op once everything is recorded.
 *
 * Flags:  --dry-run   report what WOULD be applied; touch nothing.
 * Env:    DATABASE_URL (required, Supabase session-pooler :5432)
 *         MIGRATIONS_DIR (optional; defaults to ../packages/db/migrations)
 *         GITHUB_SHA / MIGRATE_ACTOR (optional; stamped into schema_migrations.applied_by)
 * Run:    DATABASE_URL=... node --import tsx scripts/migrate.mts [--dry-run]
 */
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const MIG_DIR = process.env.MIGRATIONS_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "migrations");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const APPLIED_BY = process.env.MIGRATE_ACTOR
  ?? (process.env.GITHUB_SHA ? `deploy:${process.env.GITHUB_SHA.slice(0, 12)}` : "manual");

interface Mig { filename: string; checksum: string; sql: string; }

function repoMigrations(): Mig[] {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((filename) => {
      const buf = readFileSync(join(MIG_DIR, filename));
      return { filename, checksum: sha256(buf), sql: buf.toString("utf8") };
    });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const pool = new Pool({ connectionString: url, max: 3 });

  try {
    // The ledger table (0091). CREATE IF NOT EXISTS so a fresh DB can bootstrap before its own 0091 runs.
    await pool.query(`create table if not exists public.schema_migrations (
      filename text primary key, checksum text not null,
      applied_at timestamptz not null default now(), applied_by text )`);

    const { rows } = await pool.query<{ filename: string; checksum: string }>(
      "select filename, checksum from public.schema_migrations");
    const ledger = new Map(rows.map((r) => [r.filename, r.checksum]));

    const files = repoMigrations();
    let applied = 0, skipped = 0;

    for (const m of files) {
      const known = ledger.get(m.filename);
      if (known === m.checksum) { skipped++; continue; }                    // APPLIED
      if (known !== undefined && known !== m.checksum) {                    // CHANGED — refuse
        console.error(`  CHANGED     ${m.filename}  (ledger checksum != file — edit is disallowed; add a NEW migration instead)`);
        console.error(`\nAborting: an already-applied migration was edited. ${applied} applied, ${skipped} already current.`);
        await pool.end();
        process.exit(1);
      }
      // UNRECORDED — apply + record atomically.
      if (DRY_RUN) { console.log(`  WOULD APPLY ${m.filename}`); applied++; continue; }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(m.sql);
        await client.query(
          `insert into public.schema_migrations(filename, checksum, applied_by) values ($1,$2,$3)
             on conflict (filename) do update set checksum = excluded.checksum, applied_at = now(), applied_by = excluded.applied_by`,
          [m.filename, m.checksum, APPLIED_BY]);
        await client.query("commit");
        console.log(`  APPLIED     ${m.filename}`);
        applied++;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error(`  FAILED      ${m.filename}: ${(err as Error).message}`);
        console.error(`\nAborting on first failure (later migrations NOT applied). ${applied} applied before this.`);
        client.release();
        await pool.end();
        process.exit(1);
      } finally {
        client.release();
      }
    }

    console.log(`\n${files.length} migration file(s): ${applied} ${DRY_RUN ? "to apply" : "applied"}, ${skipped} already current.`);
    await pool.end();
  } catch (e) {
    console.error("migrate failed:", e);
    await pool.end().catch(() => {});
    process.exit(2);
  }
}
main();
