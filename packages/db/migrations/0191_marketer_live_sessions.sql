-- 0191_marketer_live_sessions.sql — a marketer's LIVE session, and what it earned.
--
-- WHY: some platform admins pay a marketer per live session rather than per month. To do that they
-- have to be able to say which deposits belong to a session, which means the marketer has to mark
-- when the session starts and ends.
--
-- THIS IS A REPORT, NOT A GATE. Attribution is unchanged: fn_pay_referral_commissions still writes
-- deposit_commissions exactly as it does today, for every deposit, whether or not anyone is live.
-- What this adds is the ability to ASK "what did this session earn", by matching commissions this
-- marketer already earned against the session's window. Nobody's pay changes because this exists;
-- an operator reads the number and decides. If per-session pay ever becomes the real rule, that is
-- a separate, deliberate change to the money path — not a side effect of a reporting table.
--
-- The window is [started_at - margin, ended_at + margin]: a viewer who deposits in the minutes
-- around a stream was moved by it just as much as one who deposited during it, and the margin is
-- what the operator tunes.
--
-- Money-neutral and idempotent: no money table is touched and nothing here can affect a balance.
begin;

-- ── Per-brand knobs. The platform admin owns these; the marketer only starts and stops. ─────────
create table if not exists public.site_live_settings (
  site_id            uuid primary key references public.sites(id) on delete cascade,
  -- Off by default: a brand that has never heard of live sessions sees no buttons.
  enabled            boolean not null default false,
  -- How long a session runs before it expires on its own, so a marketer who closes the laptop
  -- without pressing End Live does not leave one open forever.
  session_minutes    int     not null default 60  check (session_minutes between 5 and 1440),
  -- The +/- window around the session that still counts as "during the live".
  margin_minutes     int     not null default 10  check (margin_minutes between 0 and 240),
  -- How much one press of Extend adds.
  extend_minutes     int     not null default 30  check (extend_minutes between 5 and 240),
  -- 0 = unlimited. Counted per marketer per calendar day in the brand's own day.
  max_sessions_daily int     not null default 0   check (max_sessions_daily >= 0),
  updated_at         timestamptz not null default now()
);
alter table public.site_live_settings enable row level security;
grant select, insert, update on public.site_live_settings to service_role;

-- ── The sessions themselves. ────────────────────────────────────────────────────────────────────
create table if not exists public.marketer_live_sessions (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.sites(id) on delete cascade,
  marketer_id  uuid not null references public.profiles(id) on delete cascade,
  started_at   timestamptz not null default now(),
  -- When it is scheduled to end. Extending moves this; ending early does not.
  ends_at      timestamptz not null,
  -- When it actually ended, by End Live or by expiry. Null while it is running.
  ended_at     timestamptz,
  -- Where the marketer is streaming. Optional: a session is still a session without a link.
  stream_url   text,
  -- The margin IN FORCE when the session ran, copied so that changing the setting later cannot
  -- silently restate what a past session earned.
  margin_minutes int not null default 10,
  created_at   timestamptz not null default now()
);
alter table public.marketer_live_sessions enable row level security;
grant select, insert, update on public.marketer_live_sessions to service_role;

create index if not exists ix_live_sessions_site_started on public.marketer_live_sessions(site_id, started_at desc);
create index if not exists ix_live_sessions_marketer on public.marketer_live_sessions(marketer_id, started_at desc);

-- One live session per marketer per brand at a time. A partial unique index says exactly that and
-- lets the database enforce it, rather than two concurrent Start Live presses both winning.
create unique index if not exists uq_live_session_open
  on public.marketer_live_sessions(site_id, marketer_id)
  where ended_at is null;

comment on table public.marketer_live_sessions is
  'A marketer''s live stream window. REPORTING ONLY: commission attribution is unchanged (0078).';

commit;
