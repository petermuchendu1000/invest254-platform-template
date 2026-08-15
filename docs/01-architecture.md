# 01 — System Architecture

## 1. High-level diagram
```
                         ┌────────────────────────────────────────────┐
                         │                 Players                     │
                         │      (browser web app — Next.js)            │
                         └───────────────┬─────────────┬──────────────┘
                            HTTPS (REST)  │             │  WSS (realtime)
                                          ▼             ▼
   ┌───────────────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
   │   API Gateway (REST)  │   │  Game Engine (WS)  │   │  Admin Back Office (web) │
   │  Node.js / Fastify    │   │  Node.js authoritative │   Next.js + REST          │
   │  auth, wallet, kyc,   │   │  curve + round loop │   └──────────────────────────┘
   │  affiliate, payments  │   │  position settle    │
   └─────────┬─────────────┘   └─────────┬──────────┘
             │                            │
             ▼                            ▼
   ┌──────────────────────────────────────────────────────┐
   │              Supabase (managed Postgres)              │
   │  Auth · Postgres (RLS) · Storage · Realtime (pub/sub) │
   └──────────────────────────────────────────────────────┘
             │                  │                 │
             ▼                  ▼                 ▼
   ┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │ M-Pesa Daraja │  │  SMS OTP provider│  │  Redis (cache /  │
   │ STK + B2C     │  │  (Africa's Talking)│  state / locks)  │
   └───────────────┘  └──────────────────┘  └──────────────────┘
```

## 2. Components

### 2.1 Player Web App (Next.js / React)
- Renders the live curve (canvas/WebGL via `lightweight-charts` or a custom smooth-wave renderer).
- Connects to the **Game Engine** over WebSocket for ticks & round state.
- Calls the **REST API** for auth, wallet, deposits, withdrawals, history, affiliate.

### 2.2 Game Engine (authoritative Node.js WebSocket service)
- **Single source of truth** for the shared curve and round outcomes.
- Generates the smooth price wave, broadcasts ticks to all clients.
- Opens/closes positions, computes P&L and multipliers, settles atomically against the wallet.
- Enforces the configured house edge (RTP) and ×5 cap.
- Stateless-friendly: round state in Redis; durable records in Postgres.

### 2.3 REST API Gateway (Node.js / Fastify)
- Auth & sessions, KYC, wallet ops, M-Pesa callbacks, affiliate, admin endpoints.
- Validates JWTs issued by Supabase Auth; enforces role-based access.

### 2.4 Supabase
- **Auth:** phone+OTP identities, JWT issuance.
- **Postgres:** all durable data, protected by Row-Level Security (RLS).
- **Storage:** KYC docs (later), marketing assets.
- **Realtime:** optional pub/sub for non-game events (activity feed, chat, balance updates).

### 2.5 Supporting services
- **Redis:** live round state, rate limiting, idempotency keys, distributed locks for settlement.
- **M-Pesa Daraja:** STK push (deposit) + B2C (withdrawal).
- **SMS provider:** OTP delivery (e.g. Africa's Talking / Twilio).

## 3. Recommended tech stack (MVP)
| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | **Next.js 14 (App Router) + TypeScript + Tailwind** | SSR, fast, professional |
| Charting | Custom canvas smooth-wave renderer (Catmull-Rom spline) | matches "very smooth waves" requirement |
| Realtime | **Node.js + `ws`/`uWebSockets.js`** | low-latency authoritative engine |
| REST | **Node.js + Fastify + TypeScript** | performant, schema-validated |
| DB/Auth | **Supabase (Postgres 15 + Auth)** | already connected |
| Cache/state | **Redis** | round state, locks, rate limits |
| Payments | **M-Pesa Daraja** | STK push + B2C |
| Hosting | **Cloudflare Pages** (web) + **Fly.io** (engine + API) + **Supabase** (DB) — see HOSTING.md | actual production stack |
| Infra-as-code | Docker + GitHub Actions | reproducible deploys |

## 4. Why an authoritative engine (not pure Supabase Realtime)
Because **one curve drives everyone's outcomes and real money is at stake**, the curve and
settlement must be computed server-side in a trusted, tamper-proof process. Clients only *render*
ticks; they never compute outcomes. This prevents client manipulation and guarantees fairness +
consistent RTP.

## 5. Environments
`local` → `staging` → `production`. Each has isolated Supabase project, Daraja credentials
(sandbox vs live), Redis instance and secrets. See [15 — Deployment](15-deployment-devops.md).
