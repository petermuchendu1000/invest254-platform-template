-- 0202_activity_seed_topup.sql — guarantee EVERY active brand at least 5,000 seeded activity rows.
--
-- WHY A SECOND PASS. 0201 skipped any brand that already held 500 undelivered seed rows. That guard
-- was there so a rerun would top up rather than pile on, and it did its job — but it also meant the
-- brands that already had SOME seeding (cpfmarket among them) were passed over entirely and never
-- reached the 5,000 the product asks for. This pass targets a TOTAL instead of a backlog: count what
-- a brand already has, and insert only the difference. A brand already at or above the target gets
-- nothing, so this is idempotent by construction and safe beside 0201 rather than a duplicate of it.
--
-- Same contract as 0193 and 0201: every row is SEEDED SOCIAL PROOF in `activity_seed`, read by
-- nothing but the public feed, in no money table, and deletable wholesale without moving a balance,
-- payout, commission or report.
--
-- TWO THINGS ARE DELIBERATELY DIFFERENT FROM 0201.
--
--  1. A MUCH WIDER NAME POOL (160, up from 64). The feed has to read as a room, and the complaint
--     that prompted this was one name recurring everywhere. 5,000 rows over 64 names is ~78 rows
--     each; over 160 it is ~31, so within any one 40-row window a repeat is rare. The API caps a
--     name at two rows per window on top of this, but the cap is a backstop — variety should come
--     from the data, not from the server throwing rows away.
--
--  2. AMOUNTS THAT READ AS PAYOUTS. 0201's everyday win was KES 150–3,050, which on a brand that
--     displays USD renders as "+$1.76" — technically a win, and completely unconvincing as social
--     proof. The floor is lifted and the tail widened so a card says something worth reading, while
--     staying inside what this product's stake limits actually allow.
--
-- The salt differs from 0201's, so the same (site, row number) yields a DIFFERENT row — otherwise
-- this pass would regenerate 0201's rows verbatim on any brand it also touched.
--
-- Money-neutral and idempotent.
begin;

insert into public.activity_seed (site_id, kind, name, amount_cents, created_at)
with target as (
  -- The shortfall against the 5,000-row target, per active brand. Already there => need = 0 => no
  -- rows generated for that brand at all (the `where` in `gen` drops it).
  select s.id as site_id,
         greatest(0, 5000 - (select count(*) from public.activity_seed a where a.site_id = s.id))::int as need
    from public.sites s
   where s.status = 'active'
),
gen as (
  select
    t.site_id,
    -- Four independent hashes per row, one per axis; 7 hex characters are 28 bits and a 28-bit
    -- string cast to int can never set the sign bit, so each is in 0..268435455 without abs().
    ('x' || substr(md5(t.site_id::text || ':v2:kind:' || g.n), 1, 7))::bit(28)::int as h_kind,
    ('x' || substr(md5(t.site_id::text || ':v2:name:' || g.n), 1, 7))::bit(28)::int as h_name,
    ('x' || substr(md5(t.site_id::text || ':v2:amt:'  || g.n), 1, 7))::bit(28)::int as h_amt,
    ('x' || substr(md5(t.site_id::text || ':v2:time:' || g.n), 1, 7))::bit(28)::int as h_time
  from target t
  cross join lateral generate_series(1, t.need) as g(n)
  where t.need > 0
),
shaped as (
  select site_id, h_name, h_amt, h_time,
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
  -- Display-ready, and in the same shape `publicName` gives a real player (one capitalised token),
  -- so a seeded row and a real one are not told apart by their typography.
  (array[
    'Wanjiku','Kamau','Otieno','Achieng','Njoroge','Wafula','Mutua','Chebet',
    'Kiprop','Akinyi','Mwangi','Nyambura','Omondi','Wairimu','Barasa','Cheruiyot',
    'Atieno','Githinji','Maina','Kirui','Nekesa','Ouma','Simiyu','Wekesa',
    'Adhiambo','Kariuki','Muthoni','Onyango','Kibet','Naliaka','Odhiambo','Wambui',
    'Rotich','Anyango','Mbugua','Chepkoech','Juma','Makena','Mwende','Kinyua',
    'Nduta','Osoro','Wanjala','Kemboi','Awuor','Gitonga','Lagat','Njeri',
    'Brian','Mercy','Dennis','Faith','Kevin','Grace','Collins','Esther',
    'Victor','Sharon','Felix','Caroline','Patrick','Lydia','Antony','Beatrice',
    'Nasimiyu','Chelimo','Wanyonyi','Kiplagat','Wangui','Nyokabi','Mutiso','Kilonzo',
    'Mueni','Ndungu','Kipkemboi','Jerono','Chepngeno','Sifuna','Masika','Nabwire',
    'Oduya','Okwach','Apondi','Aluoch','Owino','Oloo','Nyawira','Wangeci',
    'Githua','Muriuki','Karimi','Kirimi','Mwirigi','Gatimu','Kinuthia','Ngugi',
    'Chemutai','Kiprotich','Jepchirchir','Kipsang','Tanui','Sang','Korir','Birgen',
    'Mutheu','Syombua','Mbithi','Musyoka','Nzioka','Muthama','Wambua','Kyalo',
    'Khadija','Halima','Amina','Zainab','Fatuma','Rehema','Salma','Asha',
    'Peter','Joseph','Samuel','Daniel','Michael','Stephen','George','Charles',
    'Jane','Alice','Lucy','Nancy','Rose','Joyce','Ann','Margaret',
    'Emmanuel','Erick','Edwin','Duncan','Elijah','Isaac','Moses','Simon',
    'Winnie','Purity','Eunice','Teresia','Agnes','Dorcas','Monica','Rachael',
    'Gilbert','Bernard','Vincent','Julius','Fredrick','Lawrence','Wilson','Dancan'
  ])[1 + (h_name % 160)] as name,
  -- KES CENTS, the money of record on every brand.
  case kind
    when 'win' then
      case when h_amt % 7 = 0
        then (10000 + (h_amt % 141) * 1000) * 100   -- KES 10,000–150,000: the card worth reading
        else (500   + (h_amt % 56)  * 100)  * 100   -- KES 500–6,000: the everyday win
      end
    when 'deposit' then
      (500 + (h_amt % 96) * 100) * 100              -- KES 500–10,000
    else
      -- Floored well above the KES 1,000 that `ActivityNotice.eligible` requires, so every seeded
      -- withdrawal is capable of the job it was seeded for.
      case when h_amt % 9 = 0
        then (20000 + (h_amt % 101) * 1000) * 100   -- KES 20,000–120,000
        else (1500  + (h_amt % 54)  * 250)  * 100   -- KES 1,500–15,000
      end
  end as amount_cents,
  -- -3 days .. +30 days, to the minute (47,520 minutes). The past tail populates the feed at once;
  -- the forward month is what `created_at <= now()` turns into a feed that keeps arriving.
  now() - interval '3 days' + ((h_time % 47520) * interval '1 minute') as created_at
from shaped;

commit;
