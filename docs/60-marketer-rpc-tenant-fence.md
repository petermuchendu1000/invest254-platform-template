# 60 — Marketer-RPC database brand fence (Issue 3 / A1)

**Migration:** `0199_marketer_rpc_tenant_fence.sql` · **Finding:** A1 in docs/59 · **BUGLOG:** #131

## Why

The marketer admin routes (credit, withdraw, set PIN, set status, set Fuliza, set airtime) are the
money and account-takeover surface for the marketer (till) accounts. Until now the ONLY thing confining
a site admin of brand A to their own brand's marketers was the TypeScript `marketerInScope` guard on
each route (`apps/api/src/app.marketers.ts`). That guard is correct today — but it is a single point of
failure: one future route, or one refactor that forgets the guard, is an immediate cross-tenant
takeover (re-PIN another brand's marketer), drain, or disable, with nothing behind it.

The user / brand / advance RPCs already gained a database-level brand fence in migration 0156 (F-46,
docs — `fn_assert_actor_site_scope`). The marketer RPCs were the one mutating surface still relying on
the API alone. 0199 extends the **same** fence to them, so the database enforces brand scope
independently of the API.

This is defense-in-depth, not a live hole: no exploit exists today.

## What changed

Each of the six marketer mutating RPCs gains two **optional** trailing parameters and one injected
first statement; the rest of every body is byte-identical to production.

```sql
fn_marketer_credit    (p_marketer_id, p_amount_cents, p_ref, p_meta,            p_actor, p_actor_role)
fn_marketer_withdraw  (p_marketer_id, p_amount_cents, p_ref, p_meta, p_method,  p_actor, p_actor_role)
fn_marketer_set_pin   (p_marketer_id, p_pin,                                     p_actor, p_actor_role)
fn_marketer_set_status(p_marketer_id, p_status,                                  p_actor, p_actor_role)
fn_marketer_set_fuliza(p_marketer_id, p_amount_cents,                            p_actor, p_actor_role)
fn_marketer_set_airtime(p_marketer_id, p_amount_cents,                           p_actor, p_actor_role)
```

Injected as the first statement of each:

```sql
PERFORM public.fn_assert_actor_site_scope(
  p_actor, p_actor_role,
  (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));
```

`fn_assert_actor_site_scope` (0156) raises `SITE_SCOPE_FORBIDDEN` only for a **site-tier** actor
(`role in ('admin','superadmin')`) acting outside its permitted brand set. For a platform tier, the
owner, or a NULL actor it is a no-op, and a missing marketer (NULL site) is left to the function's own
`MARKETER_NOT_FOUND`.

## Why the actor is OPTIONAL (not required like the 0156 RPCs)

`fn_marketer_credit` is also called **internally** by `fn_marketer_game_withdraw` (0109) with no actor —
the instant demo→wallet game settlement, a legitimate system path. A required actor would break that
live flow. Optional + "NULL means skip" keeps the system path untouched while the admin routes pass the
real token actor, so:

- **Admin routes** (`marketers.pg.ts`) forward `{ id: token.sub, role: token.role }` → the fence engages
  on 100% of admin marketer mutations (the backstop to `marketerInScope`).
- **Internal / system** (`fn_marketer_game_withdraw`) and the **self-service PIN reset** (identity proven
  by security answers, no admin) pass no actor → the fence is a deliberate no-op.

## Signature change + deploy-order safety

Adding params changes each signature, so a plain `CREATE OR REPLACE` would leave a second overload (and
make the internal 4-arg credit call ambiguous). Each old signature is therefore **dropped** then
recreated. plpgsql bodies carry no hard dependency, so dropping does not cascade.

The `migrate` job applies 0199 **before** the new API deploys, and this is safe in both directions:

- Old API (old arity, e.g. `fn_marketer_set_pin($1,$2)`) against the new signature → resolves via the
  two defaults → actor NULL → fence skipped → identical behaviour.
- New API passes the actor → fenced.
- A rollback (new code reverted, migration kept) is equally safe for the same reason.

## Validation

- `packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py` — 61 assertions on a throwaway Postgres 16
  with the **full** 0001..0199 set applied: cross-brand (same-platform and cross-platform) refused for
  all six RPCs; same-brand / platform-tier / owner / NULL actor pass; the internal 4-arg credit shape
  and the full `fn_marketer_game_withdraw` settlement still work; ordinary credit/idempotency/validation
  semantics unchanged; and every fenced body equals its pre-0199 definition apart from the guard line.
- `apps/api/src/app.marketers.tenantfence.test.ts` — the admin routes (single + bulk) forward the token
  actor; the in-memory repo mirrors the fence (cross-brand refused, same-brand/platform/owner/null pass).
- Full backend suite + backend/web typecheck clean.

## TS surface

- `MarketerActor = { id: string; role: string }` and optional `actor?: MarketerActor` on the six repo
  methods (`apps/api/src/app.marketers.ts`).
- `actorOf(ctx)` on the admin routes; `marketers.pg.ts` passes `actor?.id ?? null`, `actor?.role ?? null`.
- `SITE_SCOPE_FORBIDDEN → 403` added to the marketer domain-error map (the DB raise, should the backstop
  ever fire; the route's `marketerInScope` already returns the same 403 first).
