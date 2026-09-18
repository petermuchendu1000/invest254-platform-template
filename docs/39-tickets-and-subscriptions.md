# 39 — Internal Ticketing & Subscription Plans (Issue 2)

> Two operator features on top of the platform tier (docs/38): an internal escalation **ticket
> system** and per-platform **subscription plans/billing**. Branch `issue2-tickets-subscriptions`.

---

## A. Ticket system

**Flow:** an authorized admin raises a ticket (reason + urgency). It is **assigned to the platform
admin** (escalation level 0). If unresolved past its urgency **SLA** it **auto-escalates to the
System admin** (level 1). A platform admin who raises a ticket assigns it straight to the System
admin. Every escalation (auto or manual) is logged.

**Scope:** system sees all; a platform admin sees only its platform's tickets; a site admin sees
the tickets it raised. Enforced in the RPCs (`fn_ticket_in_scope`) + API + scoped list/get SQL.

**Urgency SLAs** (ops_config, tunable): CRITICAL 1h · HIGH 4h · MEDIUM 24h · LOW 72h.

**Schema (0139):** `tickets`, `ticket_escalations` (from/to level + role + reason auto|manual +
actor + note), `ticket_comments`. **RPCs:** `fn_ticket_create` / `_add_comment` / `_set_status` /
`_escalate` / `_auto_escalate` (cron). Assignment + escalation notify the assignee tier via
`user_notifications`.

**Cron:** `.github/workflows/ticket-escalation.yml` (every 15 min) → `scripts/ops_ticket_escalate.mts`
→ `fn_ticket_auto_escalate()`.

**API:** `POST /tickets`, `GET /tickets`, `GET /tickets/:id`, `POST /tickets/:id/comments|status|escalate`
(all `requireRole("admin")`; finer scope below the transport). **Web:** shared `TicketsView` mounted
at `/admin/tickets` (site admins raise/track) and `/platform/tickets` (platform admins/system manage)
— urgency+status colour-AND-text badges, SLA "auto-escalates in …" with time-remaining, escalation
timeline, comment thread.

## B. Subscription plans

**Plans (0136):** Starter (1 site / 100 users / **KES 1,000/mo**), Business (5 / 1,000 / **KES
40,000/mo**), Enterprise (unlimited / **custom**). Subscriptions attach to a **platform**.

**Lifecycle:** `trial → active → past_due → grace_period → suspended → cancelled`. New platforms
auto-provision **Trial/Starter** (trigger). The **default platform** (11 live brands, ~2,000 users)
is seeded **Enterprise/active** — grandfathered, so nothing breaks. Durations live in `ops_config`
(config-driven): trial / past-due / grace days.

**Hard enforcement (0138) — BEFORE INSERT triggers, not RPC rewrites:**
- `sites`: site quota + block on suspended/cancelled.
- `profiles` (players only): user quota + block signups on suspended.
- `positions` + `transactions`: block new play/deposits/withdrawals on a suspended/cancelled
  platform's brands. Settlement/payout completion are UPDATEs → **untouched** (in-flight trades
  still settle). Enterprise/no-sub → unlimited/serviceable, so the live hot path short-circuits.

**Governance RPCs (0137, system-only):** `fn_subscription_set_plan` / `_set_status` /
`_record_payment`; `fn_subscription_auto_advance()` (cron) walks the time-based transitions.

**Cron:** `.github/workflows/subscription-lifecycle.yml` (daily) → `scripts/ops_subscription_advance.mts`.

**API:** `GET /platform/subscription-plans`, `GET /platform/subscriptions/:id(+/events)` (reads
platform-scoped: system=any, platform_admin=own), `POST …/plan|/status|/payment` (system-only).
**Web:** `/platform/billing` — System owner manages every platform (plan / record payment / status
with dunning + suspend copy); a platform admin sees a read-only plan summary + usage meters +
status banners.

## Testing
- DB e2e `e2e_subscriptions_tickets.py` (29 scenarios: quotas, hard-suspend, lifecycle auto-advance,
  ticket flow, manual + auto escalation, scope). Full DB suite **19/19**.
- API `app.tickets.subscriptions.test.ts` (auth/scope/routing). Full engine+api **721/721**.
- Web typecheck + `next build` clean.

## Rollout
Migrations `0136–0139` additive + idempotent; apply BEFORE code deploy (CI order). Enterprise/active
default platform means zero operational change on apply. Configure repo secret `DATABASE_URL` for the
two new cron workflows (already present for deploy/pool).
