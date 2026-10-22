\set ON_ERROR_STOP on
begin;
insert into public.profiles (id, phone, username, site_id)
  values ('d0000000-0000-0000-0000-00000000d184', '254700000184', 'v0184', '00000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;
insert into public.wallets (user_id, real_balance, site_id)
  values ('d0000000-0000-0000-0000-00000000d184', 1000000, '00000000-0000-0000-0000-000000000001')
  on conflict (user_id) do update set real_balance = 1000000;

\echo '--- 1. the UNCHANGED ten-argument RPC still opens, and the ticket arrives on its own ---'
select public.fn_open_position('d0000000-0000-0000-0000-00000000d184', 25000, 'buy', 3070.1, 900, null, 184001, now(), 3, '00000000-0000-0000-0000-000000000001');
select public.fn_open_position('d0000000-0000-0000-0000-00000000d184', 25000, 'sell', 3070.2, 900, null, 184002, now(), 3, '00000000-0000-0000-0000-000000000001');
select public.fn_open_position('d0000000-0000-0000-0000-00000000d184', 25000, 'buy', 3070.3, 900, null, 184003, now(), 3, '00000000-0000-0000-0000-000000000001');
select ticket, direction, status from public.positions
 where user_id = 'd0000000-0000-0000-0000-00000000d184' order by ticket;

\echo '--- 2. tickets are ASCENDING and gapless across consecutive opens ---'
select bool_and(d = 1) as strictly_consecutive from (
  select ticket - lag(ticket) over (order by ticket) as d
    from public.positions where user_id = 'd0000000-0000-0000-0000-00000000d184'
) s where d is not null;

\echo '--- 3. the signature is still the ten-argument one, with no overload ---'
select count(*) as fn_open_position_overloads from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'fn_open_position';

\echo '--- 4. a ticket identifies exactly one trade ---'
select count(*) = count(distinct ticket) as unique_tickets from public.positions where ticket is not null;

\echo '--- 5. the unchanged settle RPC still pays out, and the ticket survives onto the receipt ---'
select id from public.positions where user_id='d0000000-0000-0000-0000-00000000d184' order by ticket limit 1 \gset pos_
select public.fn_settle_position(:'pos_id', 3075.0, 'win', 1.70, 42500);
select ticket, status, result, payout from public.positions where id = :'pos_id';
select real_balance from public.wallets where user_id = 'd0000000-0000-0000-0000-00000000d184';
rollback;
