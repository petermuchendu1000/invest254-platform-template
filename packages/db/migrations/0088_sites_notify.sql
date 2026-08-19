-- 0088_sites_notify.sql — make per-brand `sites` flags LIVE in the engine (docs/25).
--
-- The engine read `sites.pool_mode` once at boot, so toggling a brand's pool mode (or onboarding a new
-- brand) needed a redeploy. This adds a NOTIFY on `sites` changes so the engine's SitesStore refreshes
-- pool_mode in milliseconds — mirroring the `site_game_config_changed` channel (migration 0046). The
-- payload is the changed site_id so the engine refreshes exactly one brand. Additive, idempotent.
create or replace function public.fn_sites_notify() returns trigger
language plpgsql set search_path = public as $fn$
begin
  perform pg_notify('sites_changed', coalesce(NEW.id, OLD.id)::text);
  return null;  -- AFTER trigger
end $fn$;

drop trigger if exists trg_sites_notify on public.sites;
-- Fire on every INSERT (new brand) and on UPDATE of the flags the engine caches live.
create trigger trg_sites_notify
  after insert or update of pool_mode, status, default_daily_pool_cents on public.sites
  for each row execute function public.fn_sites_notify();

do $g$
begin
  revoke all on function public.fn_sites_notify() from public, anon, authenticated;
  grant  execute on function public.fn_sites_notify() to service_role;
end $g$;
