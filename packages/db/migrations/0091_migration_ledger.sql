-- 0091_migration_ledger.sql — durable applied-migrations ledger (audit rec: change tracking).
--
-- WHY: the database had NO record of which migrations were applied. Reconciliation therefore
-- required probing for the existence of each object (fragile, indirect). This table makes the
-- applied-state DETERMINISTIC and TAMPER-EVIDENT: one row per applied migration file, with a
-- sha256 checksum captured at apply time, so a migration edited after the fact is detectable and
-- the exact rebuild order is queryable. Populated by `scripts/migrations_status.mts --record`
-- (data-driven, not hard-coded here) so the file stays small and the checksums are always the
-- real bytes on disk.
--
-- Read-only convention going forward: apply a migration, then run the recorder to stamp the ledger.
-- Additive, idempotent, service-role only. Money-neutral (pure metadata).

create table if not exists public.schema_migrations (
  filename    text        primary key,
  checksum    text        not null,                 -- sha256 (hex) of the migration file at apply time
  applied_at  timestamptz not null default now(),
  applied_by  text        not null default current_user
);

comment on table public.schema_migrations is
  'Applied DB migration ledger: one row per migration file (sha256 checksum + applied_at). Backfilled for 0001-0091 on 2026-08-19. Maintained by scripts/migrations_status.mts.';

do $g$
begin
  revoke all on public.schema_migrations from public, anon, authenticated;
  grant  select, insert, update on public.schema_migrations to service_role;
end $g$;
