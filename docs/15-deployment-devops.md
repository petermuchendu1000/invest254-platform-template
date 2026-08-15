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
