# 57 — Marketer app: force sign-out + security questions + self-service reset

**Migration:** `0198_marketer_security_and_logout.sql`

The marketer till app authenticates as a `public.marketers` row (token subject = `marketers.id`, **not**
a `profiles.id`). That is exactly why none of the operator account controls reached it: the 0097
force-logout epoch lives on `profiles.sessions_valid_after`, the 0097 security questions on
`user_security_answers` (keyed to `profiles.id`), and the 0196 step-up/idle gate on
`privileged_sessions` (whose FK is `profiles.id`). A marketer held a 7-day stateless JWT with no
server-side kill switch and had **no self-service recovery at all** — PIN reset was admin-only by
design (0034), as an account-takeover guard.

This extends the proven operator pattern to the `marketers.id` identity, reusing the same audited
crypto (one enforcement point), not a second copy.

## 1. Force sign-out — `marketers.sessions_valid_after`

A force-logout epoch on the marketer row, read by `requireMarketer` (`apps/api/src/app.marketers.ts`)
on the single `profile()` it already does per request. A token whose `iat` precedes the epoch is
refused with `401 SESSION_REVOKED`, via the same `isTokenSessionValid` predicate the operator verifier
uses. Fails closed: a token with no usable `iat` on a stamped account cannot prove it post-dates the
epoch, so it is refused.

- The migration stamps `sessions_valid_after = now()` for **every** marketer — the one-time "force all
  marketers to sign out immediately". Agents simply sign back in (PIN unchanged); nothing else moves.
- A PIN or website-password reset also stamps the epoch, so changing a credential ends live sessions.
- `now()` is the **database** clock, so a skewed app clock can't strand a just-issued token.

## 2. Security questions — `marketer_security_answers`

The knowledge second factor, keyed to `marketers.id`. Same catalog (`SECURITY_QUESTIONS`), same
normalization and scrypt hashing, same no-early-exit uniform-timing verification as operators — the
marketer flow hands its stored hashes to `AuthService.hashSecurityAnswers` /
`assertSecurityAnswersAgainst`, which reuse the operator primitives. The table stores only
`(marketer_id, question_key, answer_hash)`; plaintext never reaches the DB. RLS `service_role`-only,
like every other credential table.

Routes (all under `/api/v1/marketers/auth/`):
- `GET  security-questions/catalog` — public list of selectable questions (labels).
- `POST security-questions` — authenticated marketer sets (replaces) its three answers.
- `GET  security-questions/mine` — the marketer's own chosen keys (for the reset/step-up prompt).
- `POST reset-questions` — public step 1: which keys to answer for a phone. Returns **deterministic
  decoys** for an unknown phone or one with no answers, so it cannot be used to tell a real marketer
  from a non-existent one (same decoy mechanism as the operator reset).

`securitySetupRequired` is surfaced on `GET /marketers/me` and both login responses so the app can
force a setup screen.

## 3. Forgot password — both PIN and website password, gated by the answers

Both **fail closed**: a marketer with no answers set cannot reset at all (strictly safer than today),
and every failure — unknown marketer, no answers set, wrong answers, ineligible target — collapses to
one `403 RESET_UNAVAILABLE`, so the endpoint leaks nothing. Both stamp the force-logout epoch after a
successful reset.

- `POST marketers/auth/pin/reset` — verify answers → set a new PIN (the path that was admin-only).
- `POST marketers/auth/password/reset` — verify answers → reset the **non-privileged** website
  (`profiles`) account on this phone+brand. An operator account that happens to share the phone is
  **never** reset through this path (`AuthService.setNonPrivilegedPasswordByPhone` refuses a privileged
  target outright).

Throttling mirrors the operator flows: resets are per-IP (`RATE_LIMIT_RESET_PER_MIN`, default 5/min),
answer setup per-user (`RATE_LIMIT_MFA_PER_MIN`, default 10/min).

## 4. Rollout — the one coordinated step

The till app is an **external Android client (`mpesa_2`)**, outside this repo, so it must ship a
"set your security questions" + "forgot PIN/password" UI before the knowledge factor can be
*mandatory*. Everything above ships immediately and safely: the force sign-out, the
`securitySetupRequired` signal, and the fail-closed resets (which simply stay unavailable until a
marketer has set answers, exactly as today's no-reset state).

Hard enforcement is behind one flag, **default off**: `MARKETER_SECURITY_SETUP_ENFORCED=1`. When on,
a marketer who has not set answers is blocked on action routes (e.g. demo-topup) but **never** on
`GET /marketers/me` or the setup route itself, so the block is never a dead end. Flip it once the app
supports setup.
