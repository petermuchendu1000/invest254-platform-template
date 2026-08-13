-- 0056_rls_admin.sql — admin dimension of Row-Level Security (docs/22 Task F, final item).
--
-- 0051 scoped PLAYER/affiliate reads to (auth.uid() = owner AND site_id = current_site()). This
-- adds the ADMIN read dimension so a direct anon/authenticated PostgREST session presenting an
-- admin token is bounded the same way the API's service layer already bounds it (Task E):
--   * a SITE-scoped admin (admin / superadmin / finance_admin / support) may read ONLY rows of the
--     brand its JWT `site` claim names;
--   * a PLATFORM_SUPERADMIN may read every brand's rows.
-- These are PERMISSIVE SELECT policies, OR-ed with 0051's `sel_own`, so a player/marketer token is
-- unaffected (jwt_role() is not an admin role → the admin policy contributes nothing). The app
-- itself connects as service_role (BYPASSes RLS) and remains authoritative; this is defense in
-- depth for the public keys. WRITES stay service_role-only — there are no authenticated
-- INSERT/UPDATE/DELETE policies, so PostgREST cannot mutate these tables regardless of role.
-- Additive + idempotent (drop-if-exists). Complements 0052's role model (platform_superadmin).

-- jwt_role(): the APP role from the JWT `role` claim the API mints (player/marketer/admin/
-- superadmin/platform_superadmin). Read from the per-claim GUC or the full-claims JSON; a token
-- with no role claim yields '' (→ no admin access), so anon/legacy sessions are unaffected.
create or replace function public.jwt_role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  )
$$;
grant execute on function public.jwt_role() to anon, authenticated, service_role;

-- is_site_admin(row_site): may the current session read a row belonging to `row_site`?
-- platform_superadmin → any brand; the site-scoped admin roles → only their own brand.
create or replace function public.is_site_admin(row_site uuid) returns boolean
language sql stable
as $$
  select case public.jwt_role()
    when 'platform_superadmin' then true
    when 'superadmin'    then row_site = public.current_site()
    when 'admin'         then row_site = public.current_site()
    when 'finance_admin' then row_site = public.current_site()
    when 'support'       then row_site = public.current_site()
    else false
  end
$$;
grant execute on function public.is_site_admin(uuid) to anon, authenticated, service_role;

-- Add the admin SELECT policy to every admin-read table (idempotent). Owner tables already carry
-- `sel_own` (0051); `user_overrides` + `audit_log` are admin-only reads with no owner policy.
do $mig$
declare t text;
begin
  foreach t in array array[
    'profiles','wallets','ledger_entries','positions','transactions','bonuses',
    'affiliates','referrals','affiliate_commissions','affiliate_payouts',
    'user_overrides','audit_log'
  ]
  loop
    execute format('drop policy if exists sel_admin on public.%I', t);
    execute format(
      'create policy sel_admin on public.%I for select to authenticated using (public.is_site_admin(site_id))', t
    );
  end loop;
end
$mig$;
