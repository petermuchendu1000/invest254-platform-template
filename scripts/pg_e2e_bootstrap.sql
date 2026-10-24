-- pg_e2e_bootstrap.sql — make a stock PostgreSQL look enough like Supabase to run every migration.
--
-- WHY THIS EXISTS. The 17 E2E_PG_DSN-gated tests only run when they are pointed at a database that
-- has the real schema. Pointed at anything less they fail, and pointed at nothing they silently
-- skip — which is how a "green" suite can hide them entirely. This file closes that gap: apply it
-- to an empty database, run scripts/migrate.mts, and every pg-gated test can run for real.
--
-- WHAT SUPABASE PROVIDES THAT STOCK POSTGRES DOES NOT, as used by the migrations in this repo:
--   * roles         anon / authenticated / service_role, named in every GRANT and RLS policy
--   * auth.uid()    37 call sites, in RLS policies and security-definer functions
--   * auth.users    referenced by 0002 (0015 later decouples profiles.id from it)
--   * extensions.crypt / gen_salt   0034's marketer PIN hashing (pgcrypto, under that schema name)
--
-- The shims are deliberately minimal and behave sanely: auth.uid() reads the same request GUC
-- Supabase uses, so an RLS policy evaluates the way it would in production rather than erroring.
-- This is a TEST scaffold; it is never applied to a real database, and migrate.mts is what creates
-- the actual schema on top of it.

-- ── roles ────────────────────────────────────────────────────────────────────────────────────────
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if;
  end loop;
end$$;

-- ── extensions, both at top level and under the `extensions` schema Supabase uses ────────────────
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── auth ─────────────────────────────────────────────────────────────────────────────────────────
create schema if not exists auth;

-- Supabase's user table. 0002 foreign-keys profiles.id to it; 0015 drops that reference, but the
-- table must exist for the migration history to apply in order.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- The real auth.uid() reads the JWT claim out of a request-local GUC. Reproducing that exactly is
-- what lets RLS policies be exercised rather than merely created: a test can impersonate a user
-- with  set local request.jwt.claim.sub = '<uuid>'.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), '')::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role')
$$;

create or replace function auth.email() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '')
$$;

grant usage on schema auth, extensions to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
