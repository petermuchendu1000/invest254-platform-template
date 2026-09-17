-- 0129_system_logs_app.sql — add the `app` dimension to system_logs (BUGLOG #34).
--
-- 0128 captured API request logs. The full wiring also persists the WS engine's logs (crash recovery,
-- seed rotation, pool, payments/Daraja/MegaPay) and both processes' direct console.* output. `app`
-- ('api' | 'engine' | …) lets the owner filter which process a line came from. Nullable + backfilled
-- so existing rows (all API request lines) are labelled 'api'. Additive & idempotent.

alter table public.system_logs add column if not exists app text;
update public.system_logs set app = 'api' where app is null;
create index if not exists system_logs_app_idx on public.system_logs (app);
