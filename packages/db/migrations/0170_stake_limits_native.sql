-- 0170_stake_limits_native.sql — STAKE-1: stake limits in the brand's own currency (BUGLOG #87).
--
-- The admin sets the minimum and maximum stake in the brand currency, each a multiple of 5 (a USD brand:
-- $5 .. $1,000). The player's stake pills are built from the minimum (×1, 2, 4, 5, 10, 20). The engine
-- keeps enforcing site_game_config.min_stake / max_stake in KES cents; the API writes those from these
-- values at the live rate (KES brands exactly; foreign brands with a 10% FX margin so a rate move can
-- never refuse a $5 stake). Only the service_role (the API) touches this table.
begin;

create table if not exists public.site_stake_native (
  site_id    uuid primary key references public.sites(id) on delete cascade,
  min_native numeric(14,2) not null check (min_native >= 5 and mod(min_native, 5) = 0),
  max_native numeric(14,2) not null check (max_native >= min_native and mod(max_native, 5) = 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.site_stake_native enable row level security;
revoke all on table public.site_stake_native from anon, authenticated;
grant select, insert, update, delete on table public.site_stake_native to service_role;

commit;
