# 30 — Mirroring & Migration Change-Tracking

Two mechanisms keep the platform reconstructable and prevent the repo drift that forked the template.

## A. Template mirroring (autonomous, enforced)

`invest254` (this repo) is the **single source of truth**. `invest254-platform-template` is a **true
mirror** — byte-identical, with brand values externalised to the `sites` table + secrets. The
template must never carry independent code commits; platform changes land here and flow down.

| Workflow (in the shared tree, guarded to the template repo) | Role |
|---|---|
| `.github/workflows/mirror-sync.yml` | Every 3h (+ manual): fetch this PUBLIC repo, and if the template's `main` differs, align its tree to our HEAD, **typecheck-gate**, then push. Opens a `🔴 Mirror sync blocked` issue if the gate fails. |
| `.github/workflows/mirror-drift.yml` | Daily (+ on template `main` push): read-only detector that **fails** and maintains a single rolling `🔄 Mirror drift` issue whenever the template is not identical to our HEAD. Safety net if sync is disabled. |

Both are inert here (`if: github.repository == '…/invest254-platform-template'`) and active only once
mirrored into the template. No cross-repo secret is needed: upstream is public (read), and each
workflow writes only to its own repo via `GITHUB_TOKEN`. Design follows the standard
upstream→downstream mirror + drift-issue pattern.

**To intentionally change the template, change it HERE.** Template-only commits are reverted by the
next sync — that is the point.

## B. Migration change-tracking (the ledger)

Migrations are idempotent SQL applied in order (`packages/db/migrations`). Historically the DB kept
**no record** of what was applied, so state had to be inferred by probing objects. Migration
`0091_migration_ledger.sql` adds `public.schema_migrations`:

| column | meaning |
|---|---|
| `filename` | migration file (PK) |
| `checksum` | sha256 of the file **at apply time** (tamper-evident) |
| `applied_at` / `applied_by` | when / which role applied it |

### Tooling — `scripts/migrations_status.mts`
```bash
# Report: APPLIED / CHANGED (edited after apply!) / UNRECORDED / MISSING_FILE — non-zero on any problem
DATABASE_URL=<session-pooler :5432> node --import tsx scripts/migrations_status.mts

# Record: stamp the ledger for every migration file present (backfill + after each new apply)
DATABASE_URL=<...> node --import tsx scripts/migrations_status.mts --record
```

### Apply flow going forward
1. Add `NNNN_name.sql` (idempotent).
2. Apply it to the DB.
3. `migrations_status.mts --record` to stamp the ledger.
4. `migrations_status.mts` (report) should show all `APPLIED`, 0 problems — CI can assert this.

Together: git history + the `schema_migrations` ledger (with checksums) make the schema’s evolution
fully queryable and reproducible, and the mirror workflows keep the template a faithful, always-current
base for new brands.
