-- 0151_revoke_public_function_execute.sql — Issue 1 / BUGLOG #39: close the PostgREST function
-- surface. Nearly every SECURITY DEFINER fn_* in schema public was EXECUTE-able by anon /
-- authenticated / PUBLIC, so the *public* anon key could call admin & financial RPCs directly via
-- PostgREST (fn_admin_adjust_balance, fn_admin_set_user_role, fn_approve_withdrawal, fn_admin_delete_user, …),
-- bypassing the API's guard layer entirely. Those functions authorize on the caller-supplied
-- p_actor_role argument, so exposure == compromise.
--
-- WHY *SECURITY DEFINER ONLY* (and NOT a blanket "revoke on ALL functions"):
--   A SECURITY DEFINER function runs with its OWNER's privileges — that is the escalation surface: an
--   anon caller executing one bypasses RLS and acts as the owner. A SECURITY INVOKER function runs
--   with the CALLER's privileges, so exposing it grants anon nothing beyond its own role + RLS. The
--   RLS policies themselves call INVOKER helpers (current_site, is_site_admin, current_platform,
--   fn_user_platform, jwt_role) and are EVALUATED with the querying role's privileges — a blanket
--   REVOKE would strip EXECUTE on those helpers and break the anon/authenticated RLS read path
--   ("permission denied for function current_site"), destroying the very defense-in-depth the RLS
--   layer provides for the public keys. Verified by packages/db/_testkit/e2e_platform_isolation.py.
--
-- WHY THIS IS SAFE:
--   * The web app never uses PostgREST/anon RPC — no @supabase/supabase-js, no createClient, no
--     .rpc(); all traffic goes through the API via fetch(${apiBaseUrl}/api/v1/...).
--   * The API and engine connect as the `postgres` role (owner), unaffected by anon/authenticated
--     revokes; service_role is re-granted below for any privileged server use.
--   * fn_platform_* and fn_addon_* were already revoked in earlier migrations — this generalises that
--     fix to EVERY SECURITY DEFINER function.
--
-- Idempotent (re-running converges) and reversible (rollback note at the foot).

-- 1) Close the escalation surface: no anon/authenticated/PUBLIC execute on ANY SECURITY DEFINER
--    function in public. INVOKER functions are left as-is (they cannot escalate).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    where p.prosecdef                                   -- SECURITY DEFINER only
  loop
    execute format('revoke execute on function %s from anon, authenticated, public', r.sig);
  end loop;
end $$;

-- 2) service_role (Supabase's privileged server-side key) keeps EXECUTE on everything.
grant execute on all functions in schema public to service_role;

-- 3) Fail closed for the FUTURE: newly-created functions in public are NOT auto-exposed to
--    anon/authenticated (a future SECURITY DEFINER function will not silently re-open the hole). A
--    future function that the RLS/read path legitimately needs must GRANT EXECUTE explicitly in its
--    own migration.
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
alter default privileges in schema public grant  execute on functions to service_role;

-- ── Rollback (only if a genuine anon/authenticated RPC consumer is ever introduced; prefer a
--    narrowly-scoped GRANT on the SPECIFIC function over restoring blanket DEFINER exposure) ──
--   do $$ declare r record; begin
--     for r in select p.oid::regprocedure as sig from pg_proc p
--              join pg_namespace n on n.oid=p.pronamespace and n.nspname='public' where p.prosecdef
--     loop execute format('grant execute on function %s to anon, authenticated', r.sig); end loop;
--   end $$;
--   alter default privileges in schema public grant execute on functions to anon, authenticated;
