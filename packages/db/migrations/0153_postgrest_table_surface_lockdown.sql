-- 0153_postgrest_table_surface_lockdown.sql — Issue 1 / BUGLOG #42: close the PostgREST TABLE/VIEW
-- surface (0151 closed the FUNCTION surface; this is its sibling).
--
-- THE HOLE (proven on a DB built with Supabase's default-privilege posture, see
-- packages/db/_testkit/e2e_postgrest_surface.py):
--   Supabase grants ALL on every new public table/view/sequence to anon + authenticated, so RLS is
--   the ONLY gate between the public anon key and the data. In the repo schema:
--     * 36 of 70 public tables were never RLS-enabled — incl. sites, platforms, marketers,
--       marketer_credentials (PIN hashes), marketer_wallets, commission_payouts, withdrawal_pool,
--       site_game_config, platform_global_config (kill switches), admin_actions, system_logs, tickets.
--       With the anon key: SELECT across EVERY platform, and INSERT/UPDATE/DELETE on money tables.
--     * All 14 public views ran as their OWNER (no security_invoker), so they BYPASS the RLS of the
--       tables beneath them: v_real_profiles / v_demo_profiles alone expose every player's phone
--       across every platform to the anon key.
--   A direct PostgREST read defeats the whole System > Platform > Site isolation model.
--
-- THE FIX (idempotent; app-neutral):
--   1) RLS ON for every public table. No policy == deny-all for anon/authenticated.
--   2) security_invoker = true on every public view -> a view enforces the caller's RLS.
--   3) anon/authenticated lose INSERT/UPDATE/DELETE on every table/view that has no explicit write
--      policy for them (today only push_subscriptions has one: own-row), and lose TRUNCATE /
--      REFERENCES / TRIGGER everywhere (TRUNCATE is NOT subject to RLS). Sequences: no access.
--   4) `sites`: anon/authenticated lose table-wide SELECT; `authenticated` keeps only the (id,
--      platform_id) columns, row-scoped by a claims-only policy mirroring is_site_admin. This keeps
--      the platform branch of is_site_admin() (site_platform() reads sites as the INVOKER) working
--      for defense-in-depth while exposing no brand configuration. The policy reads ONLY JWT claims
--      (jwt_role / current_site / raw `platform` claim) — never sites — so it cannot recurse.
--   5) Default privileges: future public tables do not hand anon/authenticated write/TRUNCATE, and
--      future sequences are not granted. (RLS on future tables is enforced by the CI guard
--      packages/db/migrations.guard.test.ts.)
--
-- WHY THIS IS SAFE FOR THE APP:
--   * API + engine never run as anon/authenticated (no SET ROLE, no request.jwt GUCs, no PostgREST,
--     no supabase-js — verified by code search). They connect as the table OWNER, which RLS does not
--     apply to (no FORCE ROW LEVEL SECURITY anywhere), or as a BYPASSRLS role.
--   * FAIL-CLOSED GUARD (step 0): if the migrating role is neither the owner of (nor a member of the
--     owner role of) EVERY public table, nor BYPASSRLS, the migration ABORTS before changing
--     anything — so it can never lock the app out of a table owned by some other role.
--   * Already-RLS-enabled tables and existing policies are untouched (no-op on re-run).
--
-- Rollback note at the foot.

-- 0) FAIL CLOSED: prove the migrating (== application) role is unaffected by RLS on every table.
do $$
declare bad text;
begin
  if (select rolbypassrls from pg_roles where rolname = current_user) then
    return;
  end if;
  select string_agg(c.relname, ', ' order by c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not pg_has_role(current_user, c.relowner, 'USAGE');
  if bad is not null then
    raise exception 'BLOCKED (0153): role % neither owns nor bypasses RLS on: %. Enabling RLS could lock the app out — resolve ownership first.', current_user, bad;
  end if;
end $$;

-- 1..3) RLS everywhere, invoker views, least-privilege write/sequence grants.
do $$
declare r record;
begin
  -- 1) RLS on every ordinary/partitioned table in public that lacks it.
  for r in
    select c.oid::regclass as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.t);
  end loop;

  -- 2) Every public view evaluates RLS as the CALLER (PG15+).
  for r in
    select c.oid::regclass as v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
  loop
    execute format('alter view %s set (security_invoker = true)', r.v);
  end loop;

  -- 3) Write privileges: only where an explicit write policy exists for the public roles.
  for r in
    select c.oid, c.oid::regclass as t, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
  loop
    if r.relkind <> 'v' then
      execute format('revoke truncate, references, trigger on %s from anon, authenticated, public', r.t);
    end if;
    if not exists (select 1 from pg_policy p where p.polrelid = r.oid and p.polcmd in ('a', 'w', 'd', '*')) then
      execute format('revoke insert, update, delete on %s from anon, authenticated, public', r.t);
    end if;
  end loop;

  -- 3b) Sequences: anon/authenticated never need them (they cannot insert anywhere that uses one).
  for r in
    select c.oid::regclass as s
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence %s from anon, authenticated, public', r.s);
  end loop;
end $$;

-- 4) `sites`: column-minimal, claims-scoped lookup for the RLS helpers (no brand config exposed).
revoke select on public.sites from anon, authenticated, public;
grant select (id, platform_id) on public.sites to authenticated;
drop policy if exists sites_rls_scope_lookup on public.sites;
create policy sites_rls_scope_lookup on public.sites
  for select to authenticated
  using (
    case public.jwt_role()
      when 'platform_superadmin' then true
      when 'platform_admin' then platform_id = coalesce(
        nullif(current_setting('request.jwt.claim.platform', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'platform'
      )::uuid
      when 'admin' then id = public.current_site()
      else false
    end
  );

-- 5) Fail closed for the FUTURE (objects created by this role in public).
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ── Rollback (NOT recommended — re-opens the anon-key hole). Per object, prefer a narrowly-scoped
--    policy/grant for a genuine PostgREST consumer instead. Mechanical inverse:
--   drop policy if exists sites_rls_scope_lookup on public.sites;
--   grant select on public.sites to anon, authenticated;
--   -- and for each table listed in BUGLOG #42: alter table <t> disable row level security;
--   -- and for each view: alter view <v> reset (security_invoker);
