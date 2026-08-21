-- 0097_security_questions.sql — knowledge second factor for PRIVILEGED password resets + force-logout epoch.
--
-- VULNERABILITY THIS CLOSES:
--   The public POST /api/v1/auth/password/reset flow sets a new password from a phone number alone
--   (gated only by the ALLOW_UNVERIFIED_PASSWORD_RESET flag). For an admin / superadmin /
--   platform_superadmin that is account takeover by anyone who knows the number. This migration is
--   the storage half of the fix: a per-user table of scrypt-hashed answers to Google-style security
--   questions. AuthService now REQUIRES all stored answers to match before it will reset a
--   privileged account's password — independent of the reset flag — and fails CLOSED (refuses the
--   reset) until the account has set its answers.
--
--   `sessions_valid_after` on profiles is the force-logout epoch: the API verifier rejects any
--   privileged token issued (iat) before this timestamp, so every current admin/superadmin session
--   can be invalidated in one stamp (`update profiles set sessions_valid_after = now() where role in
--   (...)`) — driving them to log in again and set their answers via the mandatory setup gate.
--
-- SECURITY MODEL (mirrors user_credentials 0015 + user_mfa 0027):
--   Answer hashes live in their own table with RLS ENABLED and NO POLICIES — unreachable via
--   anon/authenticated PostgREST, service-role only. Hashing (scrypt) + verification happen in the
--   app layer (AuthService), never in SQL, so plaintext answers never touch the database.
--
-- Additive, idempotent, money-neutral. Fully revertible (see tail).

-- ── 1. Force-logout epoch on profiles. NULL = never force-logged-out (default; all existing rows). ──
alter table public.profiles
  add column if not exists sessions_valid_after timestamptz;

comment on column public.profiles.sessions_valid_after is
  'Force-logout epoch: the API verifier rejects a privileged token whose iat precedes this timestamp. NULL = no forced logout. Set to now() to invalidate all current sessions for an account (0097).';

-- ── 2. Per-user hashed security answers. One row per (user, question_key). ──
do $$
begin
  create table if not exists public.user_security_answers (
    user_id      uuid        not null references public.profiles(id) on delete cascade,
    -- Stable catalog key (see packages/shared/src/security-questions.ts), e.g. 'first_pet'.
    question_key text        not null,
    -- scrypt hash (scrypt$N$r$p$salt$hash) of the NORMALIZED answer. Write-only from the app's view.
    answer_hash  text        not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (user_id, question_key)
  );

  -- keep updated_at fresh (set_updated_at() from 0001)
  create or replace trigger trg_user_security_answers_updated
    before update on public.user_security_answers
    for each row execute function set_updated_at();

  -- RLS with no policies: answer hashes are never reachable via anon/authenticated (service-role only).
  alter table public.user_security_answers enable row level security;
  revoke all on table public.user_security_answers from anon, authenticated;
  grant  select, insert, update, delete on table public.user_security_answers to service_role;
end
$$;

-- Fast "how many answers has this user set?" and "does this user have answers?" lookups.
create index if not exists idx_user_security_answers_user
  on public.user_security_answers(user_id);

-- ── Revert (manual) ─────────────────────────────────────────────────────────────────────────────
--   drop table if exists public.user_security_answers;
--   alter table public.profiles drop column if exists sessions_valid_after;
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
