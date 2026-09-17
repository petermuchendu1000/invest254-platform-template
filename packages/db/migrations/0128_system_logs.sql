-- 0128_system_logs.sql — persist structured system logs so the owner can VIEW them in the admin UI.
--
-- The API/engine emit one structured JSON line per request + money-path/background events through the
-- shared logger (docs/36), but only to stdout (Fly) — there was no queryable store and therefore no UI
-- (BUGLOG #33). This adds an append-only store the API's logger sink writes to (warn/error by default,
-- env LOG_PERSIST_LEVEL), an owner-only read path (GET /admin/logs), and a retention prune.
--
-- Columns mirror the logger record (docs/36): promoted queryable columns + a jsonb `fields` for the
-- rest. Text (not uuid) for user_id/site_id: log fields are free-form and must never fail an insert.

create table if not exists public.system_logs (
  id           bigint generated always as identity primary key,
  t            timestamptz not null default now(),   -- event time (from the log line; falls back to now())
  level        text not null,                          -- debug|info|warn|error
  msg          text not null,
  request_id   text,
  method       text,
  path         text,
  status       integer,
  duration_ms  integer,
  ip           text,
  user_id      text,
  role         text,
  site_id      text,
  fields       jsonb not null default '{}'::jsonb,     -- everything else (module, err, provider, …)
  created_at   timestamptz not null default now()
);

-- Newest-first keyset scan + common filters.
create index if not exists system_logs_t_id_idx   on public.system_logs (t desc, id desc);
create index if not exists system_logs_level_idx  on public.system_logs (level);
create index if not exists system_logs_status_idx on public.system_logs (status);
create index if not exists system_logs_req_idx    on public.system_logs (request_id);
create index if not exists system_logs_site_idx   on public.system_logs (site_id);

-- The API connects as the service role (DATABASE_URL); the sink inserts, the read path selects.
grant insert, select on public.system_logs to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Retention: delete rows older than keep_days (called on a periodic sweep from the API). Returns the
-- number pruned. SECURITY DEFINER so it runs regardless of the caller's grants.
create or replace function public.fn_prune_system_logs(p_keep_days integer default 30)
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare v_n integer;
begin
  delete from public.system_logs where t < now() - make_interval(days => greatest(p_keep_days, 1));
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.fn_prune_system_logs(integer) from public, anon, authenticated;
grant execute on function public.fn_prune_system_logs(integer) to service_role;
