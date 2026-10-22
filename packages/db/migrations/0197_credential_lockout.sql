-- 0197_credential_lockout.sql — per-account lockout for password login, the control the 4-digit
-- minimum was always assumed to have.
--
-- VULNERABILITY THIS CLOSES:
--   PASSWORD_MIN_LENGTH is 4, with no character classes, for EVERY role — including admin,
--   platform_admin and platform_superadmin. The codebase is explicit that this is survivable only
--   because of the throttle in front of it (packages/shared/src/credentials.ts):
--
--     "Four digits is 10,000 possibilities, so the throttle is now the ONLY thing standing between
--      an account and an exhaustive search — treat it as a security control, not a nicety, and do
--      not raise its limit without replacing it with per-account lockout."
--
--   That per-account lockout was never built. What stands in its place is a 40-request/minute
--   counter that is (a) keyed on the CALLER'S IP, never on the account under attack, so a /24 of
--   source addresses walks the whole 10,000-key space in under a minute while no single IP ever
--   trips it; (b) an in-process Map on one API machine, so the real ceiling is machines x 40 and a
--   deploy or an autoscale stop resets every bucket; and (c) a fixed window, so 80 attempts land
--   across a boundary. None of those facts is visible from the login route, which is why the gap
--   survived. The marketer till app has had real lockout since 0034 (5 failures -> 15 minutes,
--   carried through 0076/0093/0126); the accounts that can approve payouts and adjust balances
--   have had none.
--
-- WHY PROGRESSIVE AND NOT A FLAT 15 MINUTES:
--   A hard lock on an operator account is itself an attack: five deliberate wrong passwords lock a
--   brand's admin out of their own back office, and on a real-money platform locking out the person
--   who approves withdrawals is close to locking out the business. A flat 15-minute lock makes that
--   denial cheap and repeatable. The schedule below starts short enough that a mistyped password
--   costs a person almost nothing, and lengthens fast enough that an exhaustive search is hopeless:
--   the attacker's cost grows with every attempt while the legitimate user's does not, because a
--   SUCCESSFUL login clears the counter outright. Concretely, with the app-layer schedule (see
--   AuthService), 10,000 candidates cannot be tried in any useful time, while a genuine operator who
--   fumbles a password twice is never delayed at all.
--
--   This is a defence in depth, not a replacement: the right long-term fix is a password policy
--   worth the name. The schedule lives in the app layer so it can be tuned without a migration.
--
-- WHY HERE AND NOT IN THE EXISTING IP LIMITER:
--   An IP counter cannot express "this ACCOUNT is under attack", which is the only fact that
--   matters when the attacker is distributed. Durability matters for the same reason the deposit
--   gate was moved into Postgres in 0175: in-process state is not a security control when the
--   process is replaceable. These columns sit on user_credentials so the check is one read on a
--   row the login path already fetches, with no extra round trip.
--
-- SECURITY MODEL: user_credentials already has RLS ENABLED with NO POLICIES (0015) — service-role
--   only, unreachable via anon/authenticated PostgREST. These are counters and a timestamp, not
--   secrets. Note this is additive to an EXISTING table, so no new RLS statement is required (and
--   the surface guard only inspects `create table`).
--
-- Additive, idempotent, money-neutral: counters on a credential row. No balance, transaction or
-- commission is read or written. Fully revertible (see tail).
begin;

alter table public.user_credentials
  add column if not exists failed_attempts integer     not null default 0,
  add column if not exists locked_until    timestamptz,
  add column if not exists last_failed_at  timestamptz;

comment on column public.user_credentials.failed_attempts is
  'Consecutive failed password verifications. Reset to 0 on any successful login. Drives the progressive lockout schedule in AuthService (0197).';
comment on column public.user_credentials.locked_until is
  'While in the future, password login for this account is refused regardless of the password supplied. NULL = not locked.';
comment on column public.user_credentials.last_failed_at is
  'When the most recent failure happened, so a long-dormant failure streak can decay instead of accumulating forever (0197).';

commit;

-- ── Revert (manual) ─────────────────────────────────────────────────────────────────────────────
--   alter table public.user_credentials
--     drop column if exists failed_attempts,
--     drop column if exists locked_until,
--     drop column if exists last_failed_at;
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
