-- 0211_pool_auto_settings_seed_trigger.sql — adopt the pool-defaults seed trigger that production
-- has been running out-of-band (DRIFT-1 / BUGLOG #57, #161).
--
-- `schema-drift` has been red since 2026-10-14 on exactly two differences:
--     only-production  function       fn_pool_auto_settings_seed()
--     only-production  function-exec  fn_pool_auto_settings_seed()  [prod=false/false]
-- The gate was right. Production carries this function, and no migration here creates it.
--
-- WHAT IT ACTUALLY IS, which the gate could not tell us: a SECURITY DEFINER **trigger** function
-- behind a live trigger, `trg_platform_pool_defaults AFTER INSERT ON public.platforms FOR EACH ROW`.
-- The gate does not compare triggers (fixed alongside this), so only the function it calls showed up.
--
-- WHY THIS ADOPTS IT RATHER THAN DROPPING IT:
--   * It is live. 3 platforms, 3 pool_auto_settings rows.
--   * It is behaviourally redundant and therefore safe either way: `fn_pool_auto_settings_get` (0164)
--     coalesces an ABSENT row to mode='dynamic'/lookback=14 and reports `is_default` true while
--     `updated_by` is null, so a trigger-inserted bare row reads EXACTLY like no row at all; and
--     `fn_pool_auto_record_run` inserts the same row on every nightly run anyway. So the trigger only
--     moves the row's creation earlier, from the first distribution to the platform's own INSERT.
--   * The repo already does precisely this, for precisely this table-shape: 0136's
--     `trg_platform_seed_subscription`, also AFTER INSERT ON public.platforms. Whoever wrote this
--     followed that pattern by hand and never turned it into a migration.
--   * Dropping live machinery to satisfy a gate is the wrong direction when adopting it costs nothing:
--     if any consumer did depend on the row existing from day one, adopting keeps it working.
--
-- The body below is byte-identical to production's `pg_get_functiondef`, so this migration makes the
-- drift gate green rather than merely trading one difference for another.
--
-- Additive + idempotent. Service-role only, matching production's grants exactly
-- (postgres=X/postgres | service_role=X/postgres).

create or replace function public.fn_pool_auto_settings_seed()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
begin
  -- A new platform is funded from its first day. ON CONFLICT keeps this harmless if a caller has
  -- already written settings for the platform in the same transaction.
  insert into public.pool_auto_settings (platform_id)
    values (new.id)
    on conflict (platform_id) do nothing;
  return new;
end;
$fn$;

-- Postgres grants EXECUTE to PUBLIC on every newly created function, which is how BUGLOG #143
-- happened twice. A trigger function is not reachable over PostgREST, but the revoke is not
-- conditional on that: the `function-grants` CI gate asserts it for every public function.
revoke all on function public.fn_pool_auto_settings_seed() from public, anon, authenticated;
grant execute on function public.fn_pool_auto_settings_seed() to service_role;

drop trigger if exists trg_platform_pool_defaults on public.platforms;
create trigger trg_platform_pool_defaults after insert on public.platforms
  for each row execute function public.fn_pool_auto_settings_seed();

-- Backfill, for parity with 0136 §7: any platform that predates the trigger gets its row. A no-op in
-- production (3 of 3 already have one) and the reason a fresh database built from these migrations
-- ends up in the same state as production rather than one row short.
insert into public.pool_auto_settings (platform_id)
  select id from public.platforms
  on conflict (platform_id) do nothing;
