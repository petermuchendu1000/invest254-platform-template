-- 0132_rls_platform.sql — PLATFORM dimension of Row-Level Security (defense-in-depth).
--
-- 0056 bounded a direct anon/authenticated PostgREST session: a SITE-scoped admin reads only its
-- brand's rows; a platform_superadmin reads every brand's. This inserts the MIDDLE tier so a
-- `platform_admin` (JWT role=platform_admin, JWT `platform` claim = its platform) reads rows of
-- ANY site in ITS platform and NO others. The running app connects as service_role (BYPASSes RLS)
-- and stays authoritative — its per-platform scoping is enforced in the service layer + RPCs; this
-- is the matching guard for the public keys. Additive + idempotent (create-or-replace). No new
-- write policies: mutations remain service_role-only.

-- current_platform(): the platform the session is scoped to. Order of resolution:
--   1. explicit JWT `platform` claim (minted for a platform_admin);
--   2. the platform of the session's current_site() (players / site-admins / legacy tokens);
--   3. the default platform (single-tenant / no claim).
create or replace function public.current_platform() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.platform', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'platform',
    (select s.platform_id::text from public.sites s where s.id = public.current_site()),
    '10000000-0000-0000-0000-000000000001'
  )::uuid
$$;
grant execute on function public.current_platform() to anon, authenticated, service_role;

-- site_platform(site): the platform a site belongs to (stable lookup used by the admin policy).
create or replace function public.site_platform(p_site uuid) returns uuid
language sql stable
as $$ select platform_id from public.sites where id = p_site $$;
grant execute on function public.site_platform(uuid) to anon, authenticated, service_role;

-- is_site_admin(row_site): may the current session ADMIN-read a row of `row_site`?
--   platform_superadmin -> any brand;
--   platform_admin      -> any brand IN ITS platform (row's site.platform_id = current_platform());
--   site-scoped admins  -> only their own brand (unchanged).
-- Re-defining the function transparently upgrades every `sel_admin` policy created in 0056.
create or replace function public.is_site_admin(row_site uuid) returns boolean
language sql stable
as $$
  select case public.jwt_role()
    when 'platform_superadmin' then true
    when 'platform_admin' then public.site_platform(row_site) = public.current_platform()
    when 'superadmin'    then row_site = public.current_site()
    when 'admin'         then row_site = public.current_site()
    when 'finance_admin' then row_site = public.current_site()
    when 'support'       then row_site = public.current_site()
    else false
  end
$$;
grant execute on function public.is_site_admin(uuid) to anon, authenticated, service_role;
