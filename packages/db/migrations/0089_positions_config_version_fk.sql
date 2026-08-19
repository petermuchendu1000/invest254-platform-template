-- 0089_positions_config_version_fk.sql — guarantee every position can be re-priced on recovery.
--
-- Crash recovery reproduces a statistical position's committed outcome by re-pricing it under its
-- stored config_version (RecoveryService -> SeedManager.contextFor(dateKey, config_version) ->
-- settleVariable). If that version row is missing, recovery silently falls back to the LIVE config and
-- the recovered payout DIVERGES from what the player was shown. Migration 0085 already made
-- site_game_config_versions append-only (no more pruning); this adds the positions-side guarantee: a
-- position can never reference a non-existent version.
--
-- Composite FK (site_id, config_version) -> site_game_config_versions(site_id, version), added NOT
-- VALID so it enforces every NEW open without failing on the 1,606 historical rows that already
-- reference pruned versions (those pre-date the immutability guard; recovery of a >10s-old position is
-- moot anyway). MATCH SIMPLE (default) exempts rows whose config_version is NULL (legacy/no-DB dev),
-- which never occurs for engine-opened positions. Verified safe: 0 orphaned/NULL config_versions and
-- 0 config_version=0 rows in the last 3 days, so no live open path can violate it. Idempotent.
--
-- 0047 dropped the old SINGLE-column positions_config_version_fkey (pre-multi-tenant); this is the
-- correct multi-tenant composite replacement.
alter table public.positions drop constraint if exists positions_config_version_fkey;
alter table public.positions
  add constraint positions_config_version_fkey
  foreign key (site_id, config_version)
  references public.site_game_config_versions(site_id, version)
  not valid;
