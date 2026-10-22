-- 0201_activity_seed_backfill.sql — fill `activity_seed` (0193) so every brand's feed is alive.
--
-- WHAT THIS IS, AND WHAT IT IS NOT. Every row written here is SEEDED SOCIAL PROOF: a name and an
-- amount nobody deposited, withdrew or won. It goes into `activity_seed` and nowhere else, which is
-- the table 0193 created precisely so this kind of row can exist without touching the books. Not one
-- balance, payout, commission, RTP figure or daily report reads this table; `delete from
-- public.activity_seed` at any moment and the ledger is exactly as correct as it was. The real arms
-- of the feed (settled deposits, paid withdrawals, won positions — see `activity.pg.ts`) are
-- untouched and keep reporting only things that happened.
--
-- WHO SEES IT. The server gate decides, not this migration: `seededSocialProofAllowed`
-- (shared/chart.ts) permits seeded rows on the CANDLESTICK and CLASSIC (wave) screens and refuses
-- them on the digits screen and the broker terminal. Rows are nonetheless written for every active
-- brand, because the gate is evaluated per request against the brand's CURRENT trade_ui: a brand
-- switched to candlestick next month should have a living feed that afternoon, not an empty one
-- until somebody remembers to run a backfill.
--
-- WHY THE ROWS ARE SPREAD INTO THE FUTURE. `activity.pg.ts` reads `where created_at <= now()`, and
-- the note there explains what that buys: a static table becomes a LIVE feed. Rows dated ahead
-- arrive on their own schedule, so the feed keeps changing for a month instead of freezing with the
-- same forty lines the moment this runs. The window below is -3 days to +30 days: the backdated tail
-- means the feed is populated the instant this migration lands, and the forward month is what keeps
-- it moving afterwards.
--
-- WHY THE DENSITY MATTERS. `mergeByMeritWithRealFloor` contests the non-reserved slots on RECENCY,
-- so seeded rows that are all old lose every contested slot to real ones and become invisible —
-- the exact failure its comment records. ~5,000 rows per brand across 33 days is ~150 a day, about
-- one every ten minutes, which keeps a steady supply of genuinely recent seeded rows without the
-- feed reading as a firehose.
--
-- DETERMINISTIC, NOT RANDOM. Every value is derived from md5(site_id, row number, salt), so a rerun
-- on the same brands produces the same rows rather than a second, different population. `random()`
-- would also defeat the guard below, which exists so a manual rerun tops a brand up instead of
-- doubling it.
--
-- Money-neutral and idempotent.
begin;

insert into public.activity_seed (site_id, kind, name, amount_cents, created_at)
with target as (
  -- Only brands that are short of UNDELIVERED seed rows. A brand already carrying a healthy backlog
  -- of future-dated rows is left alone, so this is safe to run again and tops up rather than piles
  -- on. (Migrations run once via the ledger; this guard is for the hand that reruns it anyway.)
  select s.id as site_id
    from public.sites s
   where s.status = 'active'
     and (
       select count(*) from public.activity_seed a
        where a.site_id = s.id and a.created_at > now()
     ) < 500
),
gen as (
  select
    t.site_id,
    -- Four INDEPENDENT hashes per row, one per axis, so the kind does not determine the name and the
    -- amount does not determine the hour — one hash reused would make the feed visibly patterned.
    --
    -- The cast chain is the standard deterministic-hash trick: 7 hex characters are 28 bits, and a
    -- 28-bit string cast to int can never set the sign bit, so this is always in 0..268435455 with
    -- no abs() (which would overflow on INT_MIN) and no reliance on the undocumented hashtext().
    ('x' || substr(md5(t.site_id::text || ':kind:' || g.n), 1, 7))::bit(28)::int as h_kind,
    ('x' || substr(md5(t.site_id::text || ':name:' || g.n), 1, 7))::bit(28)::int as h_name,
    ('x' || substr(md5(t.site_id::text || ':amt:'  || g.n), 1, 7))::bit(28)::int as h_amt,
    ('x' || substr(md5(t.site_id::text || ':time:' || g.n), 1, 7))::bit(28)::int as h_time
  from target t
  cross join generate_series(1, 5000) as g(n)
),
shaped as (
  select
    site_id,
    h_name, h_amt, h_time,
    -- A trading feed is mostly wins, with deposits behind them and withdrawals the rarest — which
    -- is also the order of how much each one proves. Withdrawals are the strongest proof and the
    -- least frequent, exactly as on a real brand.
    case
      when h_kind % 100 < 52 then 'win'
      when h_kind % 100 < 82 then 'deposit'
      else 'withdrawal'
    end as kind
  from gen
)
select
  site_id,
  kind,
  -- Kenyan given names and surnames, stored DISPLAY-READY. Seed rows deliberately never pass through
  -- `publicName` (see activity.pg.ts): that function exists to shrink a real player's username to the
  -- least that still reads as a person, and there is no account behind these to protect.
  (array[
    'Wanjiku','Kamau','Otieno','Achieng','Njoroge','Wafula','Mutua','Chebet',
    'Kiprop','Akinyi','Mwangi','Nyambura','Omondi','Wairimu','Barasa','Cheruiyot',
    'Atieno','Githinji','Maina','Kirui','Nekesa','Ouma','Simiyu','Wekesa',
    'Adhiambo','Kariuki','Muthoni','Onyango','Kibet','Naliaka','Odhiambo','Wambui',
    'Rotich','Anyango','Mbugua','Chepkoech','Juma','Makena','Mwende','Kinyua',
    'Nduta','Osoro','Wanjala','Kemboi','Awuor','Gitonga','Lagat','Njeri',
    'Brian','Mercy','Dennis','Faith','Kevin','Grace','Collins','Esther',
    'Victor','Sharon','Felix','Caroline','Patrick','Lydia','Antony','Beatrice'
  ])[1 + (h_name % 64)] as name,
  -- Amounts in KES CENTS, the money of record on every brand (a display-currency figure would drift
  -- with the FX rate). Each kind has a common band and a long tail, because a feed whose every
  -- figure sits in one narrow range is the thing that reads as generated.
  case kind
    when 'win' then
      case when h_amt % 25 = 0
        then (2000 + (h_amt % 78) * 500) * 100      -- KES 2,000–40,500: the occasional big win (4%)
        else (150  + (h_amt % 59) * 50)  * 100      -- KES 150–3,050: the everyday win
      end
    when 'deposit' then
      (100 + (h_amt % 40) * 50) * 100               -- KES 100–2,050: a typical M-Pesa top-up
    else
      -- Withdrawals are floored at KES 1,000 ON PURPOSE: `ActivityNotice.eligible` only pops a card
      -- for a withdrawal at or above that, and a seeded withdrawal below it would be a row that can
      -- never do the job it was seeded for.
      case when h_amt % 11 = 0
        then (5000 + (h_amt % 46) * 1000) * 100     -- KES 5,000–50,000: a real payout (9%)
        else (1000 + (h_amt % 29) * 250) * 100      -- KES 1,000–8,000
      end
  end as amount_cents,
  -- -3 days .. +30 days, to the minute. The past tail populates the feed immediately; the forward
  -- month is what `created_at <= now()` turns into a feed that keeps arriving. 47,520 minutes.
  now() - interval '3 days' + ((h_time % 47520) * interval '1 minute') as created_at
from shaped;

commit;
