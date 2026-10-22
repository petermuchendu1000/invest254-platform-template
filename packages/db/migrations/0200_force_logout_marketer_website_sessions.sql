-- 0200_force_logout_marketer_website_sessions.sql — Issue 1 CORRECTION. BUGLOG #132.
--
-- DEFECT (the force sign-out never reached the accounts it was meant for):
-- 0198 added a force-logout epoch to the `public.marketers` identity and stamped all 24 rows. That
-- identity is the TILL APP only (token subject = marketers.id, enforced in requireMarketer on the
-- /marketers/* routes). But a marketer who signs in on the WEBSITE holds an ordinary `profiles` token
-- with role='marketer', and that session was never revoked, for TWO independent reasons:
--
--   1) `profiles.sessions_valid_after` was never STAMPED for role='marketer' (only 11 of 28 carried a
--      value at all, from unrelated earlier admin actions).
--   2) Even if it had been, it was never READ: the verifier's force-logout gate
--      (AuthService.assertSessionValid) returns early for any role not in PRIVILEGED_ROLES
--      {admin, platform_admin, platform_superadmin}, and 'marketer' is not privileged — so the DB
--      read was skipped entirely for marketer tokens.
--
-- Net effect: "force all marketers to sign out immediately" silently did nothing to the sessions the
-- marketers actually use. Marketers demo the platform on LIVE STREAMS, so this matters.
--
-- THIS MIGRATION is the data half; the code half ships with it:
--   * apps/engine/src/authservice.ts adds SESSION_GATED_ROLES = PRIVILEGED_ROLES ∪ {marketer} and
--     assertSessionValid now gates on THAT, so a marketer's website token IS checked against the
--     epoch. Deliberately a separate set from PRIVILEGED_ROLES (which drives the password-reset
--     knowledge factor + the MFA requirement, where a marketer must stay non-privileged), and players
--     are still excluded so the high-volume path keeps skipping the DB read.
--   * The 0196 five-minute IDLE timeout stays operator-only — logging a marketer out mid-demo every
--     five minutes would be worse than the problem being fixed.
--
-- Stamping both identities gives one clean "everyone signs in again" moment. now() is the DATABASE
-- clock, so a skewed app clock cannot stamp an epoch in the past and leave a just-issued token alive.
-- Idempotent and safe to re-apply (it simply moves the epoch forward, forcing a fresh sign-in).
--
-- NOTE ON THE DEPLOY WINDOW: migrate runs BEFORE the new API rolls out, so a marketer who signs in
-- during that gap gets a token issued AFTER this epoch and stays signed in. Re-stamp after the deploy
-- completes to close it (a single `update` — see docs/61).

begin;

-- The WEBSITE session: every marketer-role profile. This is the half that was missing.
update public.profiles
   set sessions_valid_after = now()
 where role = 'marketer';

-- The TILL APP session: re-stamped so both identities end at the same moment (0198 stamped these
-- once already; anyone who signed in since then is signed out again here).
update public.marketers
   set sessions_valid_after = now(),
       updated_at           = now();

commit;

-- ── Revert (manual) ───────────────────────────────────────────────────────────────────────────
-- There is no meaningful revert for a force-logout: the epoch is a point in time, and clearing it
-- would only re-admit tokens that were deliberately revoked. To undo the POLICY, revert the code
-- change (drop 'marketer' from SESSION_GATED_ROLES); to clear the stamps themselves:
-- begin;
--   update public.profiles  set sessions_valid_after = null where role = 'marketer';
--   update public.marketers set sessions_valid_after = null;
-- commit;
