-- 0204_revoke_public_execute_on_definer_fns.sql — close the two SECURITY DEFINER functions that are
-- callable with the public anon key (BUGLOG #143).
--
-- DEFECT. Migration 0153 revoked the PostgREST-reachable surface wholesale. But Postgres grants
-- EXECUTE to PUBLIC on every NEWLY created function, so each later migration has to revoke it again
-- for anything SECURITY DEFINER — and two did not:
--   * public.fn_marketer_in_practice(uuid, uuid)        (0176)
--   * public.trg_billing_platform_addon_charge()        (0172)
-- Both landed after 0153, so both have been reachable with the Supabase anon key ever since.
--
-- MEASURED IMPACT, not assumed. `fn_marketer_in_practice` is `stable` and read-only, but SECURITY
-- DEFINER, so it reads `wallets` past RLS: with the anon key it answers "is this user id a marketer
-- account in practice mode?" for any uuid. That is an identity-disclosure oracle, bounded by having
-- to guess a uuid; it moves no money. `trg_billing_platform_addon_charge` is a trigger function —
-- called directly it has no TG_OP and errors out, so the exposure is the defect rather than a usable
-- path. Neither is a money mutation, which is why this is a hardening fix and not an incident.
--
-- `service_role` keeps EXECUTE (Supabase's privileged server key, which is how the API calls these);
-- `public`, `anon` and `authenticated` lose it, matching every other locked-down function and what
-- packages/db/_testkit/e2e_function_grants.py asserts.
--
-- Idempotent: REVOKE of a privilege that is already absent is a no-op.

begin;

revoke all on function public.fn_marketer_in_practice(uuid, uuid) from public;
revoke all on function public.fn_marketer_in_practice(uuid, uuid) from anon;
revoke all on function public.fn_marketer_in_practice(uuid, uuid) from authenticated;

revoke all on function public.trg_billing_platform_addon_charge() from public;
revoke all on function public.trg_billing_platform_addon_charge() from anon;
revoke all on function public.trg_billing_platform_addon_charge() from authenticated;

-- A trigger function does NOT need EXECUTE to fire: the trigger runs as the table owner, so revoking
-- it from PUBLIC cannot break billing. Verified by re-running the entitlement e2e after this.
commit;
