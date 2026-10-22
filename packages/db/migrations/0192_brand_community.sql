-- 0192_brand_community.sql — a per-brand community channel, and the live announcement that fills it.
--
-- SHAPE: a Telegram CHANNEL, not a group. Operators post; players read and vote. There is no player
-- composer anywhere in this schema, and that is deliberate: a brand's own channel carrying an
-- unmoderated player conversation is a support and compliance surface nobody asked for. Players
-- already have a voice in the live chat on the trade screen (docs/54).
--
-- THREE TABLES:
--   community_posts        — one row per post. `kind` separates an ordinary note from a poll and
--                            from the automatic "we are live" card, so the client can render each
--                            without parsing the body.
--   community_poll_options — a poll's choices, ordered.
--   community_poll_votes   — one vote per player per POST (the primary key says so), so changing
--                            your mind updates rather than stuffing the ballot.
--
-- Notifications are NOT stored here. Going live broadcasts through the existing notification
-- machinery (0106/0141, fn_broadcast_notification), which already does per-user rows, audience
-- scoping by brand and the actor-tier checks. A second fan-out would be a second thing to get
-- wrong, and the brand-scoping in that function is the thing that stops one brand messaging
-- another's players.
--
-- Money-neutral and idempotent: nothing here touches a balance, a transaction or a commission.
begin;

create table if not exists public.community_posts (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  author_id   uuid not null references public.profiles(id),
  kind        text not null default 'post' check (kind in ('post','poll','live')),
  title       text,
  body        text not null default '',
  -- The stream link on a 'live' card. Null on everything else.
  stream_url  text,
  -- Pinned posts sort first, as a channel's pinned message does.
  pinned      boolean not null default false,
  -- A poll stops accepting votes when this is set; the post stays readable.
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.community_posts enable row level security;
grant select, insert, update, delete on public.community_posts to service_role;
create index if not exists ix_community_posts_site on public.community_posts(site_id, pinned desc, created_at desc);

create table if not exists public.community_poll_options (
  id       uuid primary key default gen_random_uuid(),
  post_id  uuid not null references public.community_posts(id) on delete cascade,
  label    text not null,
  position int  not null default 0
);
alter table public.community_poll_options enable row level security;
grant select, insert, update, delete on public.community_poll_options to service_role;
create index if not exists ix_poll_options_post on public.community_poll_options(post_id, position);

create table if not exists public.community_poll_votes (
  post_id    uuid not null references public.community_posts(id) on delete cascade,
  option_id  uuid not null references public.community_poll_options(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- ONE vote per player per poll. Re-voting updates this row rather than adding another, which is
  -- what makes the counts a count of PEOPLE rather than of clicks.
  primary key (post_id, user_id)
);
alter table public.community_poll_votes enable row level security;
grant select, insert, update, delete on public.community_poll_votes to service_role;
create index if not exists ix_poll_votes_option on public.community_poll_votes(option_id);

-- The template the live announcement broadcasts through. Insert-only: an operator who has edited
-- the wording keeps their edit on a re-apply.
insert into public.notification_templates (key, title, body, level, category, default_audience, description)
values (
  'brand_live',
  'We are live now',
  'Join the live session and trade along.',
  'info',
  -- `category` is NOT NULL on this table. It is also what a later resolve clears by, so a live
  -- announcement is its own category and ending a session can retire exactly those banners.
  'brand_live',
  '{"status":"active","roles":["player"]}'::jsonb,
  'Sent to a brand''s players when a marketer starts a live session. The real title and body are written per-send (0162 custom text) so they can carry the player''s own balance and the stream link.'
)
on conflict (key) do nothing;

commit;
