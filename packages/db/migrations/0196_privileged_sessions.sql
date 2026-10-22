-- 0196_privileged_sessions.sql — per-session state for operator step-up 2FA and the idle timeout.
--
-- WHAT THIS CLOSES, and why a table is needed at all:
--
--   1. SECOND FACTOR ONLY AT THE DOOR. TOTP (0027) and security questions (0097) are both fully
--      built and both mandatory for privileged roles — but TOTP is evaluated exactly once, at
--      sign-in (AuthService.login → assertSecondFactor), and the security questions only ever gate
--      a password RESET. Nothing in the system asks for a second factor at the moment a critical
--      action is taken. A stolen or borrowed operator token therefore carries the full authority of
--      a successfully 2FA'd session for the rest of its life: adjust any wallet, approve any M-Pesa
--      payout, promote any account to admin, rewrite the payment rails. The second factor proved a
--      person was present at login; it proves nothing about who is pressing the button now.
--
--   2. NO IDLE TIMEOUT ANYWHERE. The session token is a stateless 7-day HS256 JWT and `logout` is
--      purely client-side — it clears localStorage and the JWT stays valid for the remaining week.
--      An operator console left open on a shared or unattended machine is an open console, and
--      "logging out" does not actually close it. There is no last-activity record to time out
--      against, which is what this table supplies.
--
--   Both gaps are per-SESSION facts, not per-user facts: "this session proved a second factor at
--   14:32" and "this session was last used at 14:36". The JWT is stateless and carries no id, so
--   the session is identified by (user_id, iat) — the subject plus the issued-at second, which is
--   exactly what the API verifier already reads for the 0097 force-logout check. Binding the
--   step-up to the issuing token is the point: a second factor proven in one session must not
--   silently authorise a different token for the same operator.
--
-- WHY THE IDLE RULE IS FAIL-CLOSED BY CONSTRUCTION:
--   A missing row is not "no activity recorded, allow" — it is read as idle. A privileged token
--   whose `iat` is older than the idle window and which has no row here has, by definition, not
--   been seen inside the window, so it is refused. That makes the absence of state the safe
--   answer, and it means a pruned, dropped or never-written row can only ever lock an operator out
--   (they log in again) and never let a stale token through. Only a token issued WITHIN the window
--   is allowed to have no row yet, which is the genuine first-request-after-login case.
--
-- WHY `step_up_at` IS A TIMESTAMP AND NOT A BOOLEAN:
--   A boolean would make one TOTP code at the start of a shift authorise every critical action for
--   the next seven days, which is the hole being closed, not a fix for it. The timestamp lets the
--   gate require a RECENT proof. The window is the app's to choose (see apps/api/src/stepup.ts);
--   the column only records when the proof happened.
--
-- SCOPE: privileged roles only (admin, platform_admin, platform_superadmin). Player and marketer
--   traffic must never touch this table — it is high volume and nothing here applies to it. Note
--   marketer tokens carry `sub = marketers.id`, which is NOT a profiles.id, so the FK below would
--   reject them outright; the app-layer gate is role-scoped so they never reach it.
--
-- SECURITY MODEL (mirrors user_credentials 0015 + user_mfa 0027 + user_security_answers 0097):
--   RLS ENABLED with NO POLICIES — unreachable via anon/authenticated PostgREST, service-role only.
--   No secret is stored here at all: only timestamps and which method was used. The TOTP replay
--   counter added to user_mfa below is likewise not a secret.
--
-- Additive, idempotent, money-neutral: no balance, transaction, commission or position is read or
-- written, and nothing here can change a money figure. Fully revertible (see tail).
begin;

-- ── 1. One row per live privileged session, keyed by the token that created it. ──
do $$
begin
  create table if not exists public.privileged_sessions (
    user_id       uuid        not null references public.profiles(id) on delete cascade,
    -- The JWT's `iat`, to the second. Together with user_id this names ONE token: a re-login or a
    -- /auth/refresh mints a new iat and therefore starts a new session with no inherited step-up.
    token_iat     timestamptz not null,
    -- Last request seen on this session. The idle timeout measures from here.
    last_seen_at  timestamptz not null default now(),
    -- When a second factor was last proven ON THIS SESSION. NULL = never proven: a session may be
    -- perfectly valid for reading and still be refused a critical action.
    step_up_at    timestamptz,
    -- Which factor was used: 'totp' | 'security_questions' | 'recovery_code'. Recorded so an
    -- incident review can tell a code from a one-time recovery burn, and so the audit trail can
    -- say what was actually proven rather than just that something was.
    step_up_method text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    primary key (user_id, token_iat)
  );

  -- keep updated_at fresh (set_updated_at() from 0001)
  create or replace trigger trg_privileged_sessions_updated
    before update on public.privileged_sessions
    for each row execute function set_updated_at();

  -- RLS with no policies: session state is never reachable via anon/authenticated (service-role only).
  alter table public.privileged_sessions enable row level security;
  revoke all on table public.privileged_sessions from anon, authenticated;
  grant  select, insert, update, delete on table public.privileged_sessions to service_role;
end
$$;

-- Pruning reads by age, and an operator-wide revoke ("end every session for this user") reads by
-- user_id, which the primary key's leading column already serves.
create index if not exists idx_privileged_sessions_last_seen
  on public.privileged_sessions(last_seen_at);

comment on table public.privileged_sessions is
  'Per-session state for operator step-up 2FA and the idle timeout, keyed by (user_id, JWT iat). A missing row is read as IDLE, never as allowed — see 0196. Privileged roles only; holds no secrets.';
comment on column public.privileged_sessions.token_iat is
  'The issuing JWT''s iat, to the second. Binds a step-up proof to the one token that earned it.';
comment on column public.privileged_sessions.step_up_at is
  'When a second factor was last proven on this session. NULL = never. The gate requires a RECENT proof, not merely a proof.';

-- ── 2. TOTP replay guard on the existing MFA record (0027). ──
--
-- verifyTotp (packages/shared/src/totp.ts) accepts a code across a +/-1 step window, which is
-- correct for clock skew and is what every TOTP implementation does — but it means the SAME code is
-- accepted repeatedly for up to 90 seconds. At login that is a minor matter. For a step-up gate in
-- front of "approve this M-Pesa payout" it is not: a code read over a shoulder, screenshotted, or
-- captured from a phishing page can be replayed inside its window to authorise a second action the
-- operator never approved. Recording the highest step already consumed makes each code single-use.
alter table public.user_mfa
  add column if not exists last_totp_step bigint;

comment on column public.user_mfa.last_totp_step is
  'Highest TOTP time-step already consumed for this user. A code at or below this step is refused as a replay, making each code single-use rather than valid for its whole +/-1 step window (0196).';

commit;

-- ── Revert (manual) ─────────────────────────────────────────────────────────────────────────────
--   drop table if exists public.privileged_sessions;
--   alter table public.user_mfa drop column if exists last_totp_step;
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
