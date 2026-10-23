-- 0212_sweep_heartbeats.sql — a durable liveness record for the in-process background sweeps
-- (BUGLOG #162, docs/36 §6).
--
-- THE GAP THIS FILLS. The API's eleven background sweeps — the Daraja/MegaPay/PayHero/Paynicorn
-- deposit reconcilers, the PayHero ledger sweep, the billing reconciler, ticket auto-escalation and
-- the withdrawal-pool starvation monitor — all report only when they have something to say, and the
-- three "armed" lines that existed went to stdout rather than through the `system_logs` sink. So the
-- only durable record of the sweep layer was silence, and silence is also what a dead timer looks
-- like. We moved pool-health off a GitHub cron BECAUSE that cron failed silently (6 firings out of
-- 48); this is what stops the replacement failing the same way.
--
-- SHAPE. One row per (app, machine, name) — not per run. A heartbeat is an UPSERT of the same row,
-- so the table is permanently tiny (one row per sweep per live machine, ~11-22 rows) no matter how
-- often the sweeps fire. This is deliberately NOT `system_logs`: at one write per sweep per minute
-- a heartbeat stream would be ~16k rows/day and would bury the owner-visible log UI in noise, and
-- "which sweep is late?" would be a scan instead of a single indexed read.
--
-- WHY `machine` IS IN THE KEY. `auto_start_machines` (fly.api.toml) can bring a second API machine
-- up under load, and both sweep. Keyed without the machine, the busier machine's heartbeat would
-- mask the other's dead timer. Keyed with it, each process reports only for itself — which is also
-- the only thing a process can honestly report.
--
-- WHY NOTHING ALERTS OFF THIS TABLE. `auto_stop_machines = "stop"` stops surplus machines while
-- `min_machines_running = 1` keeps one awake, so a stopped machine leaves a legitimately stale row
-- behind. Paging off these rows would manufacture false alarms at 3am. The live process pages about
-- its own sweeps from memory (apps/engine/src/sweeps.ts); this table is the durable record for the
-- owner UI and for SQL, plus the prune that keeps departed machines from accumulating.
--
-- Additive + idempotent. Service-role only: the API writes it and the owner-only GET /admin/sweeps
-- reads it. RLS on with no policy (deny-all for anon/authenticated) per 0153.

create table if not exists public.sweep_heartbeats (
  app             text        not null,                    -- 'api' | 'engine'
  machine         text        not null,                    -- FLY_MACHINE_ID, or 'local'
  name            text        not null,                    -- e.g. 'payments.reconcile'
  every_ms        bigint      not null,                    -- the nominal cadence
  -- When the FIRST run is due, in ms after arming. Stored because the read path recomputes
  -- staleness from the timestamps (the `status` column is only as fresh as the last write, so a
  -- machine whose process died would otherwise render green), and a sweep that has never run is
  -- judged on its first-run delay, not on its cadence.
  first_run_ms    bigint      not null default 0,
  status          text        not null,                    -- pending | ok | failing | stale
  armed_at        timestamptz not null,
  last_run_at     timestamptz,
  last_ok_at      timestamptz,
  last_error_at   timestamptz,
  last_error      text,
  runs            bigint      not null default 0,
  failures        bigint      not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (app, machine, name)
);

alter table public.sweep_heartbeats enable row level security;

-- The admin read is "every sweep, worst news first"; the prune is by `updated_at`.
create index if not exists sweep_heartbeats_updated_idx on public.sweep_heartbeats (updated_at desc);

grant select, insert, update, delete on public.sweep_heartbeats to service_role;

-- One heartbeat. Called from the API's sweep registry on arm, on a status change, and at most once
-- a minute per sweep while nothing changes. SECURITY DEFINER so the write never depends on the
-- caller's grants, consistent with fn_prune_system_logs.
create or replace function public.fn_sweep_heartbeat(
  p_app           text,
  p_machine       text,
  p_name          text,
  p_every_ms      bigint,
  p_first_run_ms  bigint,
  p_status        text,
  p_armed_at      timestamptz,
  p_last_run_at   timestamptz,
  p_last_ok_at    timestamptz,
  p_last_error_at timestamptz,
  p_last_error    text,
  p_runs          bigint,
  p_failures      bigint
) returns void
language sql security definer set search_path = public
as $fn$
  insert into public.sweep_heartbeats
    (app, machine, name, every_ms, first_run_ms, status, armed_at, last_run_at, last_ok_at, last_error_at, last_error, runs, failures, updated_at)
  values
    (coalesce(p_app, 'api'), coalesce(p_machine, 'local'), p_name, coalesce(p_every_ms, 0), coalesce(p_first_run_ms, 0), p_status,
     p_armed_at, p_last_run_at, p_last_ok_at, p_last_error_at, left(p_last_error, 500),
     coalesce(p_runs, 0), coalesce(p_failures, 0), now())
  on conflict (app, machine, name) do update set
    every_ms      = excluded.every_ms,
    first_run_ms  = excluded.first_run_ms,
    status        = excluded.status,
    armed_at      = excluded.armed_at,
    last_run_at   = excluded.last_run_at,
    last_ok_at    = excluded.last_ok_at,
    last_error_at = excluded.last_error_at,
    last_error    = excluded.last_error,
    runs          = excluded.runs,
    failures      = excluded.failures,
    updated_at    = now();
$fn$;

revoke all on function public.fn_sweep_heartbeat(text, text, text, bigint, bigint, text, timestamptz, timestamptz, timestamptz, timestamptz, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.fn_sweep_heartbeat(text, text, text, bigint, bigint, text, timestamptz, timestamptz, timestamptz, timestamptz, text, bigint, bigint) to service_role;

-- Retention: a machine that is gone stops writing, so its rows would sit there looking stale
-- forever. Drop rows not touched in p_keep_days (default 7 — long enough that a machine stopped
-- over a quiet weekend is still visible, short enough that the table never grows).
create or replace function public.fn_prune_sweep_heartbeats(p_keep_days integer default 7)
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare v_n integer;
begin
  delete from public.sweep_heartbeats where updated_at < now() - make_interval(days => greatest(p_keep_days, 1));
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.fn_prune_sweep_heartbeats(integer) from public, anon, authenticated;
grant execute on function public.fn_prune_sweep_heartbeats(integer) to service_role;
