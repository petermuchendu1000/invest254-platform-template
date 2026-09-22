-- 0152_remove_superadmin_role.sql — Issue 1 / F1 + F2: remove the legacy `superadmin` tier and the
-- dead is_site_admin branches, collapsing the admin model to the authoritative 5 tiers:
--   platform_superadmin (System) > platform_admin (Platform) > admin (Site) > marketer > player.
--
-- CONTEXT / EVIDENCE:
--   * `superadmin` has ZERO live holders (verified on prod: select role,count(*) from profiles).
--   * It duplicated the SITE tier in RLS (`is_site_admin` superadmin branch == admin branch:
--     row_site = current_site()) while also acting as a per-brand "owner" tier above `admin` in the
--     app layer — a 6th, out-of-hierarchy role that made "who can do what" ambiguous.
--   * Owner-tier powers do NOT move down to `admin`; they are re-homed UP to platform_superadmin
--     (and platform_admin where brand-scoped) in the API/web layer. Because there are 0 superadmins,
--     and the owner-tier /admin routes were only reachable by platform_superadmin in practice, no
--     live user loses (or gains) access. This migration is the DB half; the code half re-gates.
--   * `finance_admin` / `support` branches in is_site_admin were UNREACHABLE (not in the role CHECK,
--     never minted by AuthService.issueToken) — dead code removed here (F2).
--
-- SCOPE (deliberately minimal to bound blast radius on a live system):
--   This migration changes ONLY (a) the profiles.role CHECK and (b) is_site_admin. The ~29 other
--   SECURITY DEFINER fn_* that still contain the literal 'superadmin' keep it as HARMLESS dead code:
--   it appears only in authorization ALLOW-LISTS (one of several accepted actor roles) and
--   PROTECTED-TARGET guards (SUPERADMIN_PROTECTED). With the role now forbidden by the CHECK and
--   0 holders, those branches can never fire — they are inert defense-in-depth. A separate, per-
--   function-tested cleanup migration may sweep them later (tracked as F1c); rewriting 29 money RPCs
--   here would be unjustified risk.
--
-- Idempotent (re-running converges) and reversible (rollback note at the foot).

-- 1) FAIL CLOSED: refuse to proceed if any superadmin profiles still exist (they must be reassigned
--    to admin / platform_admin / platform_superadmin first). On prod this is 0; on a fresh test DB
--    this is 0. This guard prevents silently orphaning a live privileged account.
do $$
declare n int;
begin
  select count(*) into n from public.profiles where role = 'superadmin';
  if n > 0 then
    raise exception 'BLOCKED: % profile(s) still have role=superadmin; reassign them before removing the role', n;
  end if;
end $$;

-- 2) Tighten the role CHECK: `superadmin` is no longer a valid role (cannot be minted or set).
--    All five authoritative tiers remain. Existing rows already satisfy this (0 superadmins).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role = any (array['player'::text,'marketer'::text,'admin'::text,'platform_admin'::text,'platform_superadmin'::text]));

-- 3) Simplify the RLS workhorse. Drop the redundant `superadmin` branch (identical to `admin`) and
--    the unreachable `finance_admin` / `support` branches. SECURITY INVOKER (unchanged) — evaluated
--    with the querying role's privileges, so it stays safe for the anon/authenticated read path.
create or replace function public.is_site_admin(row_site uuid)
returns boolean
language sql
stable
as $$
  select case public.jwt_role()
    when 'platform_superadmin' then true
    when 'platform_admin'      then public.site_platform(row_site) = public.current_platform()
    when 'admin'               then row_site = public.current_site()
    else false
  end
$$;

-- 4) Preserve the RLS read path explicitly (0151 revoked EXECUTE on SECURITY DEFINER fns only, and
--    CREATE OR REPLACE keeps existing ACL, but we re-assert the INVOKER helper's grant to be certain
--    the public keys can still evaluate RLS after this replace).
grant execute on function public.is_site_admin(uuid) to anon, authenticated, service_role;

-- ── Rollback (only if the legacy tier must return) ───────────────────────────────────────────────
--   alter table public.profiles drop constraint if exists profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role = any (array['player','marketer','admin','superadmin','platform_admin','platform_superadmin']));
--   create or replace function public.is_site_admin(row_site uuid) returns boolean language sql stable as $$
--     select case public.jwt_role()
--       when 'platform_superadmin' then true
--       when 'platform_admin' then public.site_platform(row_site) = public.current_platform()
--       when 'superadmin' then row_site = public.current_site()
--       when 'admin' then row_site = public.current_site()
--       else false end $$;
