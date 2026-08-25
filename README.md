# Invest254 — Real-Money Trade-Prediction Game

> A professional, real-money, crypto-themed **binary trade-prediction** game for the Kenyan market.
> One shared live price curve, everyone bets BUY/SELL, win up to ×5.0.

Invest254 is a fully managed gaming platform comprising a player web app, an authoritative
real-time game engine, a wallet & M-Pesa payments layer, an affiliate/marketer program, and an
administrative back office.

---

## Documentation Index

| # | Document | Contents |
|---|----------|----------|
| 00 | [Product Overview](docs/00-product-overview.md) | Vision, players, glossary, MVP scope |
| 01 | [System Architecture](docs/01-architecture.md) | Components, data flow, tech stack |
| 02 | [Game Engine & Math](docs/02-game-engine.md) | Round lifecycle, curve generation, RTP / house edge, payout math, provable fairness |
| 03 | [Realtime Protocol](docs/03-realtime-protocol.md) | WebSocket events, tick stream, position lifecycle |
| 04 | [Database Schema](docs/04-database-schema.md) | All tables, columns, relationships, RLS |
| 05 | [API Reference](docs/05-api-reference.md) | REST endpoints for every feature |
| 06 | [Authentication & KYC](docs/06-auth-kyc.md) | Phone + password, sessions, age-gate, KYC |
| 07 | [Wallet & Transactions](docs/07-wallet-transactions.md) | Balances, ledger, atomic settlement |
| 08 | [M-Pesa Payments](docs/08-payments-mpesa.md) | STK push deposits, B2C withdrawals, Daraja |
| 09 | [Affiliate / Marketer System](docs/09-affiliate-system.md) | Referrals, 25%-of-deposits marketer commission (hierarchical, rooted at each brand's default marketer), payouts |
| 10 | [Admin Back Office](docs/10-admin-panel.md) | User mgmt, finance, config, reports |
| 11 | [Activity Feed & Chat](docs/11-activity-feed-chat.md) | Live wins feed, chat moderation |
| 12 | [Bonuses & Promotions](docs/12-bonuses-promotions.md) | Welcome bonus, promo codes, wagering |
| 13 | [Frontend Spec](docs/13-frontend-spec.md) | Screens, components, UX states |
| 14 | [Security & Compliance](docs/14-security-compliance.md) | Threat model, responsible gaming, licensing |
| 15 | [Deployment & DevOps](docs/15-deployment-devops.md) | Environments, CI/CD, monitoring |
| 16 | [MVP Roadmap](docs/16-roadmap.md) | Milestones, acceptance criteria |

---

## Key Parameters (configurable in Admin)

| Parameter | MVP Value | Notes |
|-----------|-----------|-------|
| Currency | KES | Kenyan Shilling |
| Minimum stake | 250 | Quick chips 250 / 500 / 750 / 1,000 |
| Maximum multiplier | ×5.0 | "Win up to ×5.0" |
| House edge | 75% (RTP 25%) | ⚠️ Business-set; tunable per-game |
| Default round / trade duration | 10s | Auto-sell timer |
| Chart timeframes | 30s · 1m · 2m · 5m | Visualization only |
| Marketer commission | 25% of every deposit | Paid into the brand's marketer hierarchy, ALWAYS rooted at the brand's **default marketer** (`sites.owner_user_id`). Every deposit credits the default marketer 25% whether or not the player used a referral link; a sub-marketer referral splits that 25% differentially up the chain (default marketer at the root). Assign a brand's default marketer from the Platform Console → client → user → **Make brand default**. See [docs/09](docs/09-affiliate-system.md) §3. (Legacy 20%-of-GGR model deprecated; tables kept for history only.) |
| Auth | Phone + password | Self-managed (no OTP) |
| KYC (MVP) | None | Age verification & basic KYC removed (see migration 0018) |

---

## Monorepo & Services

npm workspaces (Node ≥ 20, TypeScript, ESM). Source-first: services run via `tsx` and tests
via `node --test` — no build step required for dev.

| Workspace | Package | Responsibility |
|-----------|---------|----------------|
| `packages/shared` | `@invest254/shared` | Pure, deterministic core: PRNG, curve, settlement, daily seed, money/payment helpers, chat filter, config/types |
| `packages/db` | — | SQL migrations `0001–0014`: schema, RLS, atomic money/seed/fairness/payment RPCs |
| `apps/engine` | `@invest254/engine` | Authoritative WebSocket game server + reusable services (game, daily-seed rotation, crash recovery, engagement, payments). Importable, side-effect-free barrel; the WS process starts via `npm -w @invest254/engine start` |
| `apps/api` | `@invest254/api` | REST transport (Node `http`) binding the engine services per [docs/05](docs/05-api-reference.md): public game/fairness/activity, player wallet/chat/payments + history (ledger, positions, transactions), Daraja callbacks, finance-admin withdrawal moderation |

```bash
npm install                      # install workspaces
npx tsc -b packages/shared apps/engine apps/api   # typecheck
node --import tsx --test packages/**/*.test.ts apps/**/*.test.ts   # run all tests

npm -w @invest254/engine start   # WS engine   (PORT, MASTER_SEED, DATABASE_URL, SUPABASE_JWT_*)
npm -w @invest254/api start      # REST API     (PORT=8081, DATABASE_URL, SUPABASE_JWT_*, MPESA_*)
```

Without `DATABASE_URL` the engine runs fully in-memory for local dev; the API requires
`DATABASE_URL`. Without a configured JWT verifier both run in DEV auth mode (header-trusted —
never for production).

---

> **Disclaimer:** Invest254 is a real-money gambling product. Operation requires a valid gaming
> licence and adherence to KYC/AML, responsible-gaming, tax (excise/withholding) and advertising
> rules in every jurisdiction served. See [Security & Compliance](docs/14-security-compliance.md).
