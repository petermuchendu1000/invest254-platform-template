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
mirrored into the template. Design follows the standard upstream→downstream mirror + drift-issue
pattern.

**Required secret (template only): `MIRROR_PAT`.** The default `GITHUB_TOKEN` is forbidden from pushing
changes under `.github/workflows/`, so `mirror-sync` pushes with `MIRROR_PAT` — a fine-grained PAT
scoped to the template with **contents:write + workflows:write**. Upstream is public (read needs no
secret); `mirror-drift` only reads + writes issues via `GITHUB_TOKEN`. Rotate `MIRROR_PAT` in the
template's Actions secrets when the platform PAT is rotated.

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

## C. Schema drift gate (what the schema IS, not just which files ran) — BUGLOG #57

The ledger proves which migration files ran and that none was edited afterwards. It cannot see a
change applied **outside** the migrations: on 2026-09-23 production carried an out-of-band script
(player referral codes) that also silently reverted affiliate brand hardening, with every ledger
check green. Migration 0158 reconciled it; this gate stops it recurring.

`scripts/schema_drift.mts` builds a **reference** database from `_testkit/00_supabase_shim.sql` +
Supabase-like default privileges + every migration, then compares it with production object by
object: public function bodies, anon/authenticated `EXECUTE`, row policies, indexes, views (+ options),
columns and anon/authenticated table write-grants. Extension-owned objects are ignored;
`KNOWN_DIFFERENCES` lists the few justified platform helpers.

```bash
DATABASE_URL=<production> REFERENCE_DATABASE_URL=<empty scratch db> \
  node --import tsx scripts/schema_drift.mts --build-reference     # 0 = no drift, 1 = drift, 2 = config
```

`.github/workflows/schema-drift.yml` runs it nightly (01:40 UTC), after every successful Deploy (Fly)
run, and on demand, against a Postgres 17 + pgvector service. **Rule:** never change production's
schema by hand — every change is a migration. If the gate fails, write a reconciling migration (as
0158 did) instead of editing production to match.
