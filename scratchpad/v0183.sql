\set ON_ERROR_STOP on
begin;
-- A user with money, the way the engine finds one.
insert into public.profiles (id, phone, username, site_id)
  values ('d0000000-0000-0000-0000-00000000d001', '254700000183', 'v0183', '00000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;
insert into public.wallets (user_id, real_balance, site_id)
  values ('d0000000-0000-0000-0000-00000000d001', 1000000, '00000000-0000-0000-0000-000000000001')
  on conflict (user_id) do update set real_balance = 1000000;

-- 1. Open through the UNCHANGED ten-argument money RPC.
select public.fn_open_position(
  'd0000000-0000-0000-0000-00000000d001', 25000, 'buy', 3070.12345, 900,
  null, 1183, now(), 3, '00000000-0000-0000-0000-000000000001') as opened \gset
\echo '--- 1. opened through the unchanged RPC; levels start null ---'
select id, stake, status, sl_price, tp_price from public.positions
  where user_id = 'd0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1;

-- 2. Stamp the levels by a SEPARATE update, as the engine will.
update public.positions set sl_price = 3065.50000, tp_price = 3080.25000
  where id = (select id from public.positions where user_id='d0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1);
\echo '--- 2. levels stamped outside the money path ---'
select sl_price, tp_price from public.positions
  where user_id = 'd0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1;

-- 3. Recovery's own read: the columns come back on the open-position work list.
\echo '--- 3. what listOpenPositions will now select ---'
select id, direction, duration_s, sl_price, tp_price from public.positions where status = 'open';

-- 4. Clearing one level is "not set", not zero.
update public.positions set sl_price = null
  where id = (select id from public.positions where user_id='d0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1);
\echo '--- 4. a cleared stop reads NULL, not 0 ---'
select sl_price is null as sl_is_null, tp_price from public.positions
  where user_id = 'd0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1;

-- 5. Settle through the UNCHANGED five-argument money RPC and confirm the payout is untouched.
select id from public.positions where user_id='d0000000-0000-0000-0000-00000000d001' order by opened_at desc limit 1 \gset pos_
select public.fn_settle_position(:'pos_id', 3075.00000, 'win', 1.70, 42500) as settled \gset
\echo '--- 5. settled: payout unaffected, levels preserved on the receipt ---'
select status, result, payout, sl_price, tp_price from public.positions where id = :'pos_id';
select real_balance from public.wallets where user_id = 'd0000000-0000-0000-0000-00000000d001';
rollback;
