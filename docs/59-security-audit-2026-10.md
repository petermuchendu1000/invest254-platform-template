# 59 — Security audit (2026-10) and hardening

A black-hat audit of the whole system across four surfaces: information disclosure, authorization /
multi-tenant isolation, money-movement integrity, and auth / tokens / webhooks / SSRF. Overall the
platform is unusually well-hardened — no live cross-tenant or privilege-escalation exploit was
landed, every real-money payout path is password-gated and phone-locked, and the money RPCs are
`FOR UPDATE`-locked and idempotent. The findings below are the residual weaknesses, ranked, each
marked **FIXED** (done in this pass, tested), **PROPOSED** (a live money / global-auth change held
for explicit owner approval — see the PR discussion), or **NOTED** (accepted / follow-up).

## FIXED in this pass (information-disclosure + reject-malicious-only)

| # | What | Where |
|---|---|---|
| D1 | 404/405 no longer echo the attacker-supplied method/path | `apps/api/src/http.ts` dispatcher |
| D2 | Every JSON response is `Cache-Control: no-store` (bearer tokens in several) | `http.ts` `sendJson` |
| D3 | `Access-Control-Allow-Headers` no longer advertises the dev-only `X-User-Id`/`X-User-Role` | `http.ts` `applyCors` |
| D4 | Postgres economy-feasibility CHECK → curated 422, not raw pg text naming the table + constraint | `app.admin.ts`, `app.platform.ts` |
| D5 | `SITE_NOT_FOUND` no longer reflects the caller-supplied host | `app.site.ts`, `app.activity.ts` |
| D6 | `captureConsole` object args run through the key-based redactor before hitting `system_logs` | `apps/engine/src/systemlog.ts` |
| S1 | **SSRF + gateway-secret exfiltration** via the provider "test connection" `base_url`: a caller-chosen `http://169.254.169.254/…` / internal host turned the probe (which carries the decrypted provider secret) into blind SSRF + credential exfiltration. Now rejected before any fetch: https-only, no loopback/private/link-local/metadata/`.internal`. | `apps/engine/src/gatewaytest.ts` `assertSafeGatewayUrl` |
| S2 | Non-constant-time secret compares → timing side-channel on the Telegram webhook secret and the Paynicorn postback signature. Both now `timingSafeEqual`. | `app.telegram.ts`, `apps/engine/src/paynicorn.ts` |

Residual on S1: a public hostname that later DNS-rebinds to a private address is not caught (needs
resolve-and-pin); the direct-literal and internal-hostname vectors the audit demonstrated are closed.

## Status update (owner-approved, implemented in part 3)

C-1, C-2, C-3 and AU1 below were approved and are now **FIXED** (see the part-3 PR):
- **C-2 FIXED** — `clientIp()` trusts only Fly's edge `Fly-Client-IP`; the spoofable `X-Forwarded-For`
  fallback is gone, so the callback CIDR lock and per-IP rate limits can no longer be bypassed by a
  header. (Owner confirmed the app is reachable only via Fly's proxy.)
- **C-1 FIXED (code half)** — the C2B confirmation amount is capped at the authenticated-deposit
  ceiling (KES 250,000); a forged confirmation can no longer store an unbounded amount. The shortcode
  check was **deliberately dropped**: all live C2B rows carry `org_shortcode = "payhero"` (the PayHero
  paybill path shares `fn_ingest_c2b`), so a `shortcode = paybill_config` check would have broken the
  live PayHero deposit flow. With C-2 fixed, the owner setting `MPESA_CALLBACK_ALLOWED_CIDRS` now
  actually locks the rail to Safaricom's IPs — the remaining owner action.
- **C-3 FIXED** — `MPESA_VERIFY_CALLBACKS=false` is honoured only when a callback CIDR lock is
  configured to compensate; with no lock, STKPushQuery verification stays on regardless.
- **AU1 FIXED** — the JWT verifier now rejects a validly-signed token whose role is not one this
  platform issues (e.g. a Supabase-Auth `authenticated` token), closing the unbounded-trust gap
  without needing `iss`/`aud` secrets set.

### A1 — FIXED (migration 0199, standalone PR; see docs/60)
The marketer money/PIN RPC fence was first deferred because it is **not** clean-additive:
`fn_marketer_credit` is called internally by `fn_marketer_game_withdraw` (0108/0109) with no actor, so
forcing required `p_actor`/`p_actor_role` onto it would break the live marketer game-withdrawal flow;
and `fn_marketer_withdraw`'s defaulted params make an appended *required* arg illegal. The standalone
0199 design resolves both with **OPTIONAL** trailing actor params on all six marketer mutating RPCs
(`_credit` / `_withdraw` / `_set_pin` / `_set_status` / `_set_fuliza` / `_set_airtime`), fenced by the
existing `fn_assert_actor_site_scope` (0156) only when a site-tier role is passed:
- The admin routes (`apps/api/src/marketers.pg.ts`) now forward the token actor, so the DB fence
  engages on 100% of admin marketer mutations — the backstop to `marketerInScope`.
- The internal `fn_marketer_game_withdraw → fn_marketer_credit` 4-arg call and the self-service PIN
  reset pass **no** actor, so the fence is a deliberate no-op there; the live game-withdrawal flow is
  untouched (proven end-to-end).
- Deploy-order safe both ways (old API ↔ new signature resolves via the defaults; a rollback is
  equally safe). Each old signature is dropped then recreated; bodies are byte-identical to production
  apart from the one injected guard line (verified by a pre/post diff).
Validated on a throwaway Postgres 16 with the full 0001..0199 set applied:
`packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py` (61 assertions) + the TS wiring/semantics tests
in `apps/api/src/app.marketers.tenantfence.test.ts`.

## Remaining OWNER actions (no code pending — these are secret/config changes)

- **Set `MPESA_CALLBACK_ALLOWED_CIDRS`** to Safaricom's published ranges (shipped in `.env.example`).
  With C-2 fixed, this is what finally locks the C2B rail (C-1) to Safaricom — the code half is done.
- **(Optional, stronger) set `SUPABASE_JWT_ISSUER` / `SUPABASE_JWT_AUD`** to the exact values your
  tokens carry, then enforcement can be turned on. AU1's role-allowlist already blocks foreign tokens
  without this, so it is defence-in-depth, and enforcing with wrong/absent values would reject all
  logins — hence owner-set only.

## NOTED — accepted or low-priority follow-up

- **AU2 (LOW)** `/w/act` reject executes with only the HMAC link (no password, token not bound to
  amount, 72h expiry). Reject only returns funds (no attacker gain); approve is password-gated.
  Follow-up: bind the token to the amount and shorten the expiry.
- **A2 (LOW)** The F-44 scope-registry guard (`app.scope.matrix.e2e.test.ts`) filters to
  `admin|platform|tickets|addons|support`, so the admin-gated `/community/:id/{pin,close,delete}`
  routes are not matrix-tested. Safe today (they scope by the token's own `site` claim). Follow-up:
  widen the guard to every operator-gated id route (needs those handlers to 404 on a no-op first).
- **A3 (INFO)** `app.tickets.ts` / `app.addons.ts` / `app.notifications.ts` / `app.push.ts` admit a
  raw `platform_admin` via `requireRole("admin")` and defer scoping to the RPC — verified correctly
  re-fenced in each RPC, but the inverse single-point-of-failure to A1.
- Daraja/MegaPay/PayHero callbacks re-query the provider before crediting (safe even with the CIDR
  off); provider secrets are AES-256-GCM at rest; impersonation `act` claim is never read for authz.
