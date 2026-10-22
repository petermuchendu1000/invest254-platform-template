-- 0198_marketer_security_and_logout.sql — a force-logout epoch and a knowledge second factor for
-- the marketer-APP agents (public.marketers), mirroring the 0097/0196 controls already in place for
-- operators, and extending them to the one identity that was deliberately left out.
--
-- WHY THIS EXISTS
--   The marketer till app authenticates as a `public.marketers` row (token subject = marketers.id,
--   NOT a profiles.id — see apps/api/src/app.marketers.ts and apps/api/src/stepup.ts), which is
--   precisely why the 0097 force-logout epoch (profiles.sessions_valid_after) and the 0097 security
--   questions (user_security_answers, keyed to profiles.id) never reached them. A marketer who signs
--   in holds a 7-day stateless JWT with no server-side kill switch, and has no self-service PIN or
--   password reset at all (0034 line 16-18: admin-only, by design, as an account-takeover guard).
--
-- WHAT THIS ADDS
--   (1) marketers.sessions_valid_after — the force-logout epoch, read by the marketer gate
--       (requireMarketer) exactly as the API verifier reads profiles.sessions_valid_after for an
--       operator. A token minted before the epoch is refused on the next request. Stamped to now()
--       for every marketer at the foot of this migration: the "force all marketers to sign out
--       immediately" step. Agents simply sign back in (PIN unchanged); nothing else is disturbed.
--   (2) marketer_security_answers — the knowledge second factor, keyed to marketers.id. Hashes are
--       computed in the app layer (AuthService scrypt, the SAME scheme and the SAME verification as
--       the operator security answers — one audited enforcement point, never a second copy), so this
--       table stores only (marketer_id, question_key, answer_hash). It gates the new self-service PIN
--       and website-password resets, fail-closed: a marketer with no answers set cannot reset at all,
--       which is strictly safer than today and matches how resetPassword already treats operators.
--
-- SCOPE / SAFETY
--   Additive and idempotent. No money table is read or written; no balance, ledger, commission,
--   position or transaction is touched. The only data write is stamping the force-logout epoch, whose
--   sole effect is to require a fresh sign-in. Fully revertible (see tail). The marketer_profiles
--   view is re-created with security_invoker = true preserved (0153 guard) and the new column APPENDED
--   last, so every by-name consumer is unaffected (the 0096 precedent).

begin;

-- (1) Force-logout epoch on the marketer identity. NULL = never forced out (the default for any new
--     marketer created after this migration until an epoch is stamped).
alter table public.marketers
  add column if not exists sessions_valid_after timestamptz;

comment on column public.marketers.sessions_valid_after is
  'Force-logout epoch for the marketer app (0198): the marketer gate (requireMarketer) refuses a '
  'token whose iat precedes this. NULL = no forced logout. Set to now() to sign every live session '
  'out. Mirrors profiles.sessions_valid_after (0097) for the marketers.id identity.';

-- (2) Marketer knowledge second factor. One row per (marketer, question). Hash is the app-layer
--     scrypt hash of the normalized answer — identical scheme to user_security_answers (0097).
create table if not exists public.marketer_security_answers (
  marketer_id  uuid        not null references public.marketers(id) on delete cascade,
  question_key text        not null,
  answer_hash  text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (marketer_id, question_key)
);

comment on table public.marketer_security_answers is
  'Security-question answers for the marketer app (0198), keyed to marketers.id. Gates the '
  'self-service PIN and website-password resets, fail-closed (no answers set => reset refused). '
  'Answer hashes are scrypt, computed in AuthService — the same scheme/verification as '
  'user_security_answers; this table never sees plaintext. Undo: drop table.';

-- RLS: service_role only, like every other credential-bearing table (0015/0027/0097/0196). The app
-- connects as the table owner / a BYPASSRLS role, so this is defence-in-depth against a leaked
-- anon/publishable key, not the app's own access path.
alter table public.marketer_security_answers enable row level security;
revoke all on table public.marketer_security_answers from anon, authenticated;
grant  select, insert, update, delete on table public.marketer_security_answers to service_role;

-- Re-create the marketer profile view with the epoch APPENDED. Columns and order are otherwise
-- byte-for-byte the 0096 definition; security_invoker is restated so the 0153 guard holds and the
-- replace does not silently reset it.
create or replace view public.marketer_profiles
  with (security_invoker = true) as
select
  m.id,
  m.name,
  public.fn_first_name(m.name) as first_name,
  public.fn_initials(m.name)   as initials,
  m.phone,
  m.status,
  w.balance_cents,
  w.available_fuliza_cents,
  w.airtime_balance_cents,
  w.currency,
  w.updated_at as wallet_updated_at,
  m.created_at,
  m.site_id,
  s.name as brand_name,
  m.sessions_valid_after
from public.marketers m
join public.marketer_wallets w on w.marketer_id = m.id
left join public.sites s on s.id = m.site_id;

-- The one-time "force all marketers to sign out immediately" action. now() is the DATABASE clock, so
-- a just-issued token cannot slip past an epoch stamped in the past by a skewed app clock.
update public.marketers set sessions_valid_after = now();

commit;

-- ── Revert (manual) ───────────────────────────────────────────────────────────────────────────
-- NOTE: `create or replace view` can only APPEND columns, never drop one, so restoring the 14-column
-- 0096 view means DROPPING the view first (not replacing it) — and the view must go before the
-- column it now selects can be dropped. Order below is deliberate.
-- begin;
--   drop view if exists public.marketer_profiles;
--   create view public.marketer_profiles with (security_invoker = true) as
--   select m.id, m.name, public.fn_first_name(m.name) as first_name, public.fn_initials(m.name) as initials,
--          m.phone, m.status, w.balance_cents, w.available_fuliza_cents, w.airtime_balance_cents,
--          w.currency, w.updated_at as wallet_updated_at, m.created_at, m.site_id, s.name as brand_name
--     from public.marketers m
--     join public.marketer_wallets w on w.marketer_id = m.id
--     left join public.sites s on s.id = m.site_id;
--   drop table if exists public.marketer_security_answers;
--   alter table public.marketers drop column if exists sessions_valid_after;
-- commit;
