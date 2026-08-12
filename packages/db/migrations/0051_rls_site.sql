-- 0051_rls_site.sql — add the SITE dimension to Row-Level Security (docs/22 Task F).
--
-- 0008 gave every owner table a self-access SELECT policy (auth.uid() = user_id). This adds the
-- SECOND dimension: an authenticated session may read a row ONLY IF it also belongs to the brand
-- the session is scoped to. This matters because the anon/publishable + authenticated keys reach
-- the DB directly via PostgREST, so RLS — not the API — is what stops one brand's client from
-- reading another brand's rows. (The app itself connects as service_role, which BYPASSes RLS; its
-- per-site scoping is enforced in the service layer, proven by the app + DB money e2e.)
--
-- current_site(): the brand the current session is scoped to, from the JWT `site` claim the API
-- mints. Read from either the per-claim GUC (request.jwt.claim.site) or the full-claims JSON
-- (request.jwt.claims -> 'site'); a token without the claim (legacy/single-tenant) falls back to
-- the default brand, so existing single-tenant behaviour is unchanged.

create or replace function public.current_site() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.site', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'site',
    '00000000-0000-0000-0000-000000000001'
  )::uuid
$$;
grant execute on function public.current_site() to anon, authenticated, service_role;

-- Re-create each owner SELECT policy with the brand check appended. Idempotent (drop-if-exists).
do $mig$
begin
  drop policy if exists sel_own on public.profiles;
  create policy sel_own on public.profiles for select to authenticated
    using (auth.uid() = id and site_id = public.current_site());

  drop policy if exists sel_own on public.wallets;
  create policy sel_own on public.wallets for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.ledger_entries;
  create policy sel_own on public.ledger_entries for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.positions;
  create policy sel_own on public.positions for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.transactions;
  create policy sel_own on public.transactions for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.bonuses;
  create policy sel_own on public.bonuses for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.affiliates;
  create policy sel_own on public.affiliates for select to authenticated
    using (auth.uid() = user_id and site_id = public.current_site());

  drop policy if exists sel_own on public.referrals;
  create policy sel_own on public.referrals for select to authenticated
    using (auth.uid() = affiliate_id and site_id = public.current_site());

  drop policy if exists sel_own on public.affiliate_commissions;
  create policy sel_own on public.affiliate_commissions for select to authenticated
    using (auth.uid() = affiliate_id and site_id = public.current_site());

  drop policy if exists sel_own on public.affiliate_payouts;
  create policy sel_own on public.affiliate_payouts for select to authenticated
    using (auth.uid() = affiliate_id and site_id = public.current_site());
end
$mig$;
