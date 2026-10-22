# 68 — Resetting an operator's forgotten security answers

**Status:** implemented · **Date:** 2026-10-16
**Touches:** migration `0210`, `apps/api/src/app.admin.ts`, `packages/shared/src/capabilities.ts`,
`apps/web/src/components/platform/PlatformAdminsPanel.tsx`. **Related:** `32` (security questions
and 2FA), `0097`, `0196` (step-up), `0198` (the separate marketer-app factor).

---

## 1. The problem — VERIFIED

Security answers (`0097`) are a knowledge factor stored scrypt-hashed in `user_security_answers`.
They are never readable, by anyone, by design. There was consequently **no recovery path**: an
operator who forgot their answers stayed locked out of whatever those answers gate.

For a **site admin** that is not a corner of the product, it is the product: `apps/api/src/stepup.ts`
asks a site admin for *knowledge* (the answers) and the platform tiers for *possession* (TOTP). So a
brand admin who forgets their answers cannot satisfy step-up, and step-up guards every money action
in the back office.

The only remedy was a hand-written `DELETE` against production, which is both unaudited and exactly
the kind of operation that hits the wrong row.

## 2. What a reset is — VERIFIED

Deleting the rows **is** the reset. `securitySetupRequired` on `/auth/me` is computed from the
stored count (`authservice.ts:731`), so emptying the set flips that flag and `SecurityQuestionsGate`
forces the person to choose and answer three fresh questions at next load.

The operator running the reset never learns, chooses or sets the new answers. They clear a slot; the
person fills it.

**No deadlock**, verified on both sides: `POST /api/v1/auth/security-questions` is step-up exempt in
the server's `STEP_UP_EXEMPT` set (`stepup.ts:87`) and in the client's `isStepUpExemptPath`, so
someone with no answers can still enrol. Everything else stays fail-closed — with nothing stored,
step-up cannot be satisfied, so gated actions are refused until the new set exists.

## 3. Who may reset whom — DECIDED

The ladder is copied from `fn_admin_set_user_status` (`0156`) rather than invented, because a second
factor is at least as sensitive as a ban, and a second ladder would be a second thing to keep in
step. Enforced in `fn_admin_reset_security_answers`, re-stated in the in-memory mirror, and asserted
one refusal-code at a time in `app.admin.resetsecurity.test.ts`.

| Rule | Code | Why |
|---|---|---|
| Actor must be `platform_admin`+ | `NOT_AUTHORIZED` | A **site admin is refused**. One site admin clearing another's second factor is a lateral move inside a tier, not supervision. |
| Never yourself | `NO_SELF_ACTION` | **The load-bearing one.** Anyone holding a live privileged session could otherwise drop their own knowledge factor and enrol a replacement — step-up rewriting itself from inside a session. |
| Never a `platform_superadmin` target | `SUPERADMIN_PROTECTED` | Recovering the top of the tree is break-glass, not a button another account can press. |
| A `platform_admin` target needs a `platform_superadmin` actor | `INSUFFICIENT_PRIVILEGE` | Peers do not reset peers. |
| A `platform_admin` actor is confined to its own platform | `PLATFORM_SCOPE_FORBIDDEN` | `fn_user_platform`, as every other platform-scoped RPC. |
| Brand fence | — | `fn_assert_actor_site_scope`, first statement, like every actor-on-user RPC. |

**Sessions end in the same transaction.** Clearing the answers while a session is live would leave
that session inside its existing step-up window, still acting with a factor that no longer exists.
Stamping `profiles.sessions_valid_after` (`0097`) forces re-authentication, so the next thing the
person meets is the setup gate.

Audited to `admin_actions` as `user.reset_security_answers`, with the actor, the target's role and
how many answers were discarded.

## 4. Where the button is — and the gap — VERIFIED

The control is a third section of `PlatformAdminsPanel` (`/platform/platforms`), reusing the
cross-brand person search that the appoint flow already uses. It is a **separate section, not a
per-row button** on the platform-admins list, because the person who gets locked out is usually a
*brand* admin — and brand admins never appear in that list.

**The gap, stated plainly: the UI works for the system owner only.** The search it depends on,
`GET /platform/users/search`, is gated `requireRole("platform_superadmin")` — "System owner only",
deliberately, since it reads a directory across every brand. The reset API is gated `platform_admin`+
and the RPC enforces the platform fence, so a platform admin *may* call it, but has no screen from
which to find a person.

That was left as-is rather than widening the search gate: quietly turning an owner-only cross-brand
directory into a platform-tier one is a privilege expansion that has nothing to do with this
feature. **To close it**, add a platform-scoped user search (results confined to the caller's own
platform via `fn_user_platform`) and point the section's search at that when the caller is a
platform admin. Until then, a platform admin who needs a reset asks the system owner.

## 5. Scope — DECIDED

`profiles` only. The marketer app authenticates as a `marketers.id` with its own answers table
(`marketer_security_answers`, `0198`) and its own fail-closed self-service reset; it is untouched.
A marketer-side equivalent is a straight parallel if it is ever wanted, and should be a separate
RPC rather than a widened one — the two identities are deliberately not interchangeable.

**Not reset here:** TOTP. Note the consequence — for a `platform_admin` or the system owner the
step-up factor is *possession*, so clearing their answers restores the password-reset path but does
not restore step-up. This feature is therefore most meaningful for site admins, whose step-up factor
is the answers themselves. A 2FA reset is a separate decision with a different risk profile.
