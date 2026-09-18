-- 0131_platform_tier.sql — introduce the PLATFORM tier (System > Platform > Site).
--
-- Issue 1 (roles & scope). Today the ladder is: platform_superadmin (SYSTEM, global) -> sites ->
-- admin (SITE, one brand). There is no grouping between the global owner and individual sites.
-- This adds the missing MIDDLE tier:
--
--   platform_superadmin   = SYSTEM ADMIN  (one owner; global; unchanged; e.g. zrinok)
--     └─ platform_admin    = PLATFORM ADMIN (NEW; scoped to ONE platform = a set of sites)
--          └─ admin         = SITE ADMIN    (scoped to ONE site; unchanged)
--               └─ marketer / player        (per site; unchanged)
--
-- What this migration does (additive + idempotent, safe for a live DB):
--   1. `platforms` grouping entity (owns sites).
--   2. A single DEFAULT platform, owned by the system owner (platform_superadmin) if one exists.
--   3. `sites.platform_id`  — NOT NULL, DEFAULT + backfill to the default platform, FK, indexed.
--   4. `profiles.platform_id` — nullable; the platform a `platform_admin` administers.
--   5. role CHECK gains `platform_admin`.
--   6. A CHECK so a `platform_admin` row can never exist without a platform_id (fail-closed scope).
--
-- ZERO behaviour change for existing tiers: every current site is assigned to ONE default platform,
-- so the system owner still sees everything and site admins stay site-scoped exactly as before.
-- The isolation only becomes visible once additional platforms are created and platform_admins are
-- appointed (a later, deliberate console action), which is exactly the requested design.

-- ── 1. platforms ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.platforms (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  owner_user_id uuid references public.profiles(id),
  status        text not null default 'active' check (status in ('active','suspended','archived')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── 2. The default platform (fixed id so code + backfill agree). Owned by the system owner if one
--        already exists (production: zrinok). On a fresh/test DB no owner exists yet -> NULL, fine.
insert into public.platforms (id, slug, name, status)
  values ('10000000-0000-0000-0000-000000000001', 'default', 'Default Platform', 'active')
  on conflict (id) do nothing;

update public.platforms p
   set owner_user_id = (select id from public.profiles
                          where role = 'platform_superadmin' order by created_at asc limit 1),
       updated_at = now()
 where p.id = '10000000-0000-0000-0000-000000000001'
   and p.owner_user_id is null;

-- ── 3. sites.platform_id — NOT NULL with a DEFAULT so existing rows + any not-yet-updated insert
--        path backfill to the default platform (never breaks), FK + index for the scope joins.
alter table public.sites
  add column if not exists platform_id uuid not null
    default '10000000-0000-0000-0000-000000000001'
    references public.platforms(id);
create index if not exists idx_sites_platform on public.sites(platform_id);

-- ── 4. profiles.platform_id — nullable; set for a platform_admin (the platform they administer).
--        Players / site admins / the system owner do not use it (their scope is site / global).
alter table public.profiles
  add column if not exists platform_id uuid references public.platforms(id);
create index if not exists idx_profiles_platform on public.profiles(platform_id);

-- ── 5. Role model gains platform_admin (superset of a site admin, subset of the system owner). ───
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('player','marketer','admin','superadmin','platform_admin','platform_superadmin'));

-- ── 6. Fail-closed scope: a platform_admin MUST carry a platform_id (else it would be unscoped).
--        No platform_admin exists yet, so this validates instantly with zero violations.
alter table public.profiles drop constraint if exists profiles_platform_admin_scope_chk;
alter table public.profiles add constraint profiles_platform_admin_scope_chk
  check (role <> 'platform_admin' or platform_id is not null);
