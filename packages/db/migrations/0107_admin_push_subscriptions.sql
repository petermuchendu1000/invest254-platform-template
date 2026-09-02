-- 0107_admin_push_subscriptions.sql — Web Push subscriptions for real-time admin alerts.
--
-- Issue 1: admins/superadmins must RECEIVE withdrawal-request notifications in real time (a
-- browser/OS push "like Google's") with inline Approve/Reject actions — instead of having to log
-- in and poll the withdrawal queue. Each admin device that opts in registers a W3C Push API
-- subscription (endpoint + p256dh + auth keys); the API stores it here and the server sends a Web
-- Push (VAPID) message to every matching admin when a pending withdrawal is created.
--
-- Scoping mirrors withdrawal moderation (docs/22 Task H): a subscription carries the admin's
-- site_id at opt-in time. A site-scoped admin is alerted only for its own brand's withdrawals; a
-- platform admin / superadmin (site_id IS NULL) is alerted for every brand.
--
-- Written/read by the engine/API as the service role (RLS-bypassing). RLS is still enabled with a
-- self-manage policy as defense-in-depth. Idempotent: safe to re-apply.

create table if not exists public.push_subscriptions (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null references public.profiles(id) on delete cascade,
  site_id       uuid        references public.sites(id) on delete cascade,  -- null = platform-wide (superadmin)
  endpoint      text        not null,
  p256dh        text        not null,   -- client public key (base64url) for payload encryption
  auth          text        not null,   -- client auth secret (base64url)
  user_agent    text,
  failure_count int         not null default 0,   -- consecutive push failures; pruned on 404/410 (gone)
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- One row per browser push endpoint. Re-subscribing (same endpoint) upserts rather than duplicates.
create unique index if not exists uq_push_subscriptions_endpoint
  on public.push_subscriptions (endpoint);

-- Hot path: "all admin subscriptions for this brand (+ platform-wide)" when a withdrawal fires.
create index if not exists idx_push_subscriptions_user
  on public.push_subscriptions (user_id);
create index if not exists idx_push_subscriptions_site
  on public.push_subscriptions (site_id);

alter table public.push_subscriptions enable row level security;

-- Defense-in-depth: an admin may read/manage only their own device rows. All server-side sends go
-- through the service role (RLS-bypassing), so no policy is granted to anon/authenticated for the
-- cross-admin fan-out read.
drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select using (auth.uid() = user_id);
drop policy if exists push_subscriptions_modify_own on public.push_subscriptions;
create policy push_subscriptions_modify_own on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
