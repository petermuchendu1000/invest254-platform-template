# 15 — Deployment & DevOps

## 1. Environments
| Env | Web | Engine/API | DB | M-Pesa |
|-----|-----|-----------|----|--------|
| local | Next dev | node dev + ws | Supabase local / branch | Daraja sandbox |
| staging | Cloudflare Pages (preview) | Fly.io | Supabase staging project | Daraja sandbox |
| production | Cloudflare Pages (`invest254`) | Fly.io — API `invest254-api`, engine `invest254-engine-pm` | Supabase prod | Daraja production |

> The production stack is **Cloudflare Pages + Fly.io + Supabase**. **HOSTING.md is the single
> source of truth** for app names, URLs, deploy commands, and the legacy apps to avoid.

## 2. Repository layout (monorepo)
```
invest254/
├─ docs/                  # this documentation
├─ apps/
│  ├─ web/                # Next.js player app
│  ├─ admin/              # Next.js admin back office
│  ├─ engine/             # Node.js authoritative WS game engine
│  └─ api/                # Node.js Fastify REST API
├─ packages/
│  ├─ shared/             # types, money utils, validation schemas
│  └─ db/                 # SQL migrations, RLS policies, seed
└─ .github/workflows/     # CI/CD
```

## 3. Database migrations
- SQL migrations in `packages/db/migrations` (versioned). RLS policies + seed (`game_config`
  singleton, super-admin user) applied on deploy. Never hand-edit prod schema.

## 4. CI/CD (GitHub Actions)
- On PR: lint, typecheck, unit tests (incl. **RTP Monte-Carlo test**, wallet-atomicity tests),
  build. On merge to `main`: deploy staging → smoke tests → manual promote to prod.

### 4.1 Which workflow runs where
Both repositories carry the same byte-identical tree (docs/30), so what actually *runs* is decided
by each job's `if`, not by which repository the file sits in.

| Workflow | Fires on | Allocates a runner in |
|---|---|---|
| `ci.yml` | PR, push `main` | both — the template's copy is how the mirror is validated |
| `deploy.yml` | `workflow_run` of CI (+ dispatch) | production only, from `fly-auth` onward |
| `mirror-sync.yml` / `mirror-drift.yml` | every 3h / daily + push | template only |
| `pool-distribute.yml`, `subscription-lifecycle.yml`, `reproducibility.yml`, `schema-drift.yml` | nightly (+ post-deploy) | any repo that is not the mirror |
| `ticket-escalation.yml`, `pool-health.yml` | dispatch only — their timers live in the API process | any repo that is not the mirror |

### 4.2 Five rules, each of which cost something before it existed (BUGLOG #155, #156, #157)
GitHub rounds **each job** up to the nearest minute, which is why all of these are about jobs rather
than steps. `scripts/workflows.guard.test.mts` enforces them inside `npm test`.

1. **Every job declares `timeout-minutes`, and none exceeds 60.** Without one a job inherits
   GitHub's 360-minute ceiling; one stalled `fly deploy` then ran for six hours, held the
   `fly-deploy` concurrency group, and left the API five days behind `main` (#155).
2. **Size the cap from the measured distribution, not from the typical run.** `deploy`'s legs
   finish in 1-2 minutes, but one healthy deploy spent 22 of them in the image export phase. A
   25-minute cap would have failed it; the cap is 45 (#156). Leave the measurement in a comment
   beside the number — and treat a cap as the backstop for a build that will never finish, never as
   the fix for one that is slow for a reason (see rule 5).
3. **A job that cannot do its work must not start.** Guard it with a job-level `if` — a step that
   exits 0 early still bills a whole minute, a skipped job bills nothing. Write the guard as
   `github.repository != '<template>'`, never `== '<production>'`: the mirror is never a running
   brand, but a brand repo forked from the template is, and must keep the cron.
4. **Superseded runs are cancelled; a run on `main` is not.** `main`'s result is the record that
   the commit was green, and it is the input `deploy.yml`'s `gate` reads.
5. **The deploy matrix is serial (`max-parallel: 1`), and stays that way.** Both legs build the
   same root Dockerfile, so Fly gives them one remote builder and buildkit deduplicates their
   layers against each other; run them together and one leg can sit in `exporting to image`
   indefinitely while the other ships in a minute — four times in sixty runs, never both legs
   (#157). Because the matrix is `fail-fast: false`, each occurrence left a split release that
   reported success. The price is a 1-2 minute window where one app is newer than the other, which
   is strictly better than an unbounded one. Keep `fail-fast: false`: with serial legs it is the
   only thing that still attempts the second app when the first fails.

### 4.3 What the time goes on, and why most of it stays
`npm test` is ~52% of CI's job-minutes. 1,973 of its 2,360 tests finish inside 100ms; **25 tests are
51% of its CPU** — the provable-fairness Monte-Carlo proofs and the WS market-data integration
tests. They are expensive because they are exhaustive, and exhaustive because the exploits they rule
out were real (BUGLOG #15, #18, docs/25 §16). **This is not a cost to optimise.**

### 4.4 Actions billing
Both repositories are **public**, so GitHub-hosted standard runners are free:
`GET /actions/runs/{id}/timing` reports `billable.UBUNTU.total_ms: 0` for every job, the six-hour
hang included. Runner minutes here are a queue-health and reliability concern, not an invoice. If
the account's Actions budget is being consumed, it is being consumed somewhere else — another
repository, an organisation, or a different line item (Packages, LFS, Codespaces) on the same bill.
Check the owner's billing breakdown, not these workflows.

## 5. Secrets & config
- GitHub Actions secrets / platform secret stores for: Supabase URL+keys (anon + service-role),
  Daraja creds, SMS creds, Redis URL, JWT settings. **Never** commit secrets.

## 6. Observability
- Structured logs (engine, api), error tracking (Sentry), metrics (tick latency, settle time,
  realised RTP, deposit success rate), uptime alerts. Daily reconciliation report to finance.

## 7. Scaling notes
- Engine is the hot path: a single authoritative curve broadcast via fan-out; scale WS via a pub/sub
  (Redis) so multiple gateway instances share one engine-produced tick stream. Settlement remains
  serialized per user via locks.

## 8. Backups & DR
- Supabase automated backups + point-in-time recovery; periodic ledger snapshots; documented restore
  runbook; seed-reveal archive for fairness audits.
