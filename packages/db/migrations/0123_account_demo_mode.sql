-- 0123_account_demo_mode.sql — Player-facing DEMO MODE (real <-> demo account toggle).
--
-- Extends the marketer demo isolation (0084) to ANY user via a per-(user,site) `account_mode`, while
-- reusing the exact same, proven demo bucket (`wallets.demo_balance`, non-withdrawable by construction
-- because fn_create_withdrawal / fn_marketer_game_withdraw debit real_balance only).
--
-- INVARIANTS (all covered by e2e_account_demo_mode.py):
--   1. Demo stakes/payouts touch demo_balance ONLY; never real/bonus (and vice-versa).
--   2. Demo funds are never withdrawable and never convert to real (withdrawal path unchanged).
--   3. Demo trades are excluded from the real cohort views (real turnover/GGR/analytics stay clean).
--   4. Real players in real mode are byte-for-byte unaffected (real+bonus path identical to 0084).
--   5. Routing is decided SERVER-SIDE (reads the wallet), never trusted from the client.
--
-- KEY CORRECTNESS FIX vs 0084: settlement now routes by the bucket STORED ON THE POSITION at open
-- (`positions.demo`), NOT by the caller's identity/mode at settle time. Because a user's mode can
-- change between open and settle, deriving demo-ness from identity at settle (the 0084 behaviour)
-- would pay a demo trade into REAL. Storing it at open makes open/settle consistent by construction.
--
-- Additive + idempotent + revertible (new column defaults preserve current behaviour for everyone).

begin;

-- ── 1. Per-(user,site) active account mode. Default 'real' => zero behaviour change on deploy. ──────
alter table public.wallets
  add column if not exists account_mode text not null default 'real'
    check (account_mode in ('real','demo'));

-- ── 2. The bucket a position was staked from, decided at OPEN. Settlement MUST route by this. ───────
alter table public.positions
  add column if not exists demo boolean not null default false;

create index if not exists idx_positions_demo on public.positions(site_id, demo) where demo;

-- ── 3. Canonical "is this trade demo?" predicate: marketer (always demo) OR wallet mode = demo. ─────
create or replace function public.fn_account_is_demo(p_user uuid, p_site_id uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select public.fn_is_marketer_account(p_user)
      or coalesce((select account_mode = 'demo' from public.wallets
                    where user_id = p_user and site_id = p_site_id), false);
$$;

-- ── 4. Switch the caller's active account mode. Marketers are always demo (forced). ────────────────
create or replace function public.fn_set_account_mode(p_user uuid, p_site_id uuid, p_mode text)
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare v_mode text;
begin
  if p_mode not in ('real','demo') then raise exception 'INVALID_MODE'; end if;
  v_mode := case when public.fn_is_marketer_account(p_user) then 'demo' else p_mode end;
  update public.wallets set account_mode = v_mode, updated_at = now()
    where user_id = p_user and site_id = p_site_id;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  return v_mode;
end;
$$;

-- ── 5. Self-service demo top-up (any account). Demo funds are non-withdrawable, so this can never be
--       farmed into real cash. Refills to KES 10,000 (1,000,000 cents) if below; no-op at/above. ────
create or replace function public.fn_topup_demo_account(p_user uuid, p_site_id uuid)
 returns bigint language plpgsql security definer set search_path to 'public'
as $$
declare v_target bigint := 1000000; v_bal bigint; v_new bigint;
begin
  select demo_balance into v_bal from public.wallets
    where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal >= v_target then return v_bal; end if;         -- already funded -> no-op (can't be farmed)
  update public.wallets set demo_balance = v_target, updated_at = now()
    where user_id = p_user and site_id = p_site_id returning demo_balance into v_new;
  insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, p_site_id, 'adjustment', v_target - v_bal, 'demo', null, null,
            jsonb_build_object('reason', 'self_topup_demo_mode'));
  return v_new;
end;
$$;

-- ── 6. fn_open_position (rise/fall): route by fn_account_is_demo; tag the position's bucket. ────────
create or replace function public.fn_open_position(p_user uuid, p_stake bigint, p_direction text, p_entry_rate numeric, p_duration_s integer, p_game_day bigint, p_nonce bigint, p_opened_at timestamp with time zone, p_config_version bigint, p_site_id uuid)
 returns table(position_id uuid, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_bal bigint; v_id uuid; v_min bigint; v_max bigint; v_demo boolean;
        v_real bigint; v_bonus bigint; v_from_bonus bigint; v_from_real bigint;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;

  select min_stake, max_stake into v_min, v_max from site_game_config where site_id = p_site_id;
  if v_min is not null and p_stake < v_min then raise exception 'STAKE_BELOW_MIN'; end if;
  if v_max is not null and p_stake > v_max then raise exception 'STAKE_ABOVE_MAX'; end if;

  v_demo := public.fn_account_is_demo(p_user, p_site_id);   -- marketer OR wallet mode = demo (server-side)

  if v_demo then
    select demo_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = demo_balance - p_stake where user_id = p_user
      returning demo_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version, demo)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version, true);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text);
    return query select v_id, v_bal;
    return;
  end if;

  select real_balance, bonus_balance into v_real, v_bonus
    from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_real + v_bonus < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;

  v_from_bonus := least(v_bonus, p_stake);
  v_from_real  := p_stake - v_from_bonus;
  update wallets set bonus_balance = bonus_balance - v_from_bonus,
                     real_balance  = real_balance  - v_from_real
   where user_id = p_user returning real_balance into v_bal;

  v_id := gen_random_uuid();
  insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                        status, nonce, opened_at, config_version, demo)
    values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
            'open', p_nonce, p_opened_at, p_config_version, false);
  if v_from_real > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_real, 'real', 'positions', v_id::text);
  end if;
  if v_from_bonus > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_bonus, 'bonus', 'positions', v_id::text);
  end if;
  update bonuses set wagered = wagered + p_stake
   where user_id = p_user and status = 'active';

  return query select v_id, v_bal;
end;
$function$;

-- ── 7. fn_open_contract (digit/multiplier/rise_fall): same demo routing + bucket tag. ──────────────
create or replace function public.fn_open_contract(p_user uuid, p_stake bigint, p_kind text, p_contract jsonb, p_direction text, p_entry_rate numeric, p_duration_s integer, p_game_day bigint, p_nonce bigint, p_opened_at timestamp with time zone, p_config_version bigint, p_site_id uuid)
 returns table(position_id uuid, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_bal bigint; v_id uuid; v_min bigint; v_max bigint; v_demo boolean;
        v_real bigint; v_bonus bigint; v_from_bonus bigint; v_from_real bigint;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_kind not in ('rise_fall','digit','multiplier') then raise exception 'INVALID_KIND'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;
  if p_duration_s <= 0 then raise exception 'INVALID_DURATION'; end if;

  select min_stake, max_stake into v_min, v_max from site_game_config where site_id = p_site_id;
  if v_min is not null and p_stake < v_min then raise exception 'STAKE_BELOW_MIN'; end if;
  if v_max is not null and p_stake > v_max then raise exception 'STAKE_ABOVE_MAX'; end if;

  v_demo := public.fn_account_is_demo(p_user, p_site_id);   -- marketer OR wallet mode = demo (server-side)

  if v_demo then
    select demo_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = demo_balance - p_stake where user_id = p_user
      returning demo_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version, kind, contract, demo)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version, p_kind, p_contract, true);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text);
    return query select v_id, v_bal;
    return;
  end if;

  select real_balance, bonus_balance into v_real, v_bonus
    from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_real + v_bonus < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;

  v_from_bonus := least(v_bonus, p_stake);
  v_from_real  := p_stake - v_from_bonus;
  update wallets set bonus_balance = bonus_balance - v_from_bonus,
                     real_balance  = real_balance  - v_from_real
   where user_id = p_user returning real_balance into v_bal;

  v_id := gen_random_uuid();
  insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                        status, nonce, opened_at, config_version, kind, contract, demo)
    values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
            'open', p_nonce, p_opened_at, p_config_version, p_kind, p_contract, false);
  if v_from_real > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_real, 'real', 'positions', v_id::text);
  end if;
  if v_from_bonus > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_bonus, 'bonus', 'positions', v_id::text);
  end if;
  update bonuses set wagered = wagered + p_stake
   where user_id = p_user and status = 'active';

  return query select v_id, v_bal;
end;
$function$;

-- ── 8. fn_settle_position: route by the POSITION's stored bucket (belt-and-braces OR marketer, so a
--       marketer position opened BEFORE this migration — demo defaulted false — still settles demo). ─
create or replace function public.fn_settle_position(p_position uuid, p_exit_rate numeric, p_result text, p_multiplier numeric, p_payout bigint)
 returns table(settled boolean, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_status text; v_user uuid; v_stake bigint; v_bal bigint; v_site uuid; v_demo boolean;
        v_bonus record; v_convert bigint;
begin
  if p_result not in ('win','loss','void') then raise exception 'INVALID_RESULT'; end if;
  if p_payout < 0 then raise exception 'INVALID_PAYOUT'; end if;
  select status, user_id, stake, site_id, demo into v_status, v_user, v_stake, v_site, v_demo
    from positions where id = p_position for update;
  if not found then raise exception 'POSITION_NOT_FOUND'; end if;

  -- Authoritative bucket = the one debited at open (stored on the row). OR marketer for pre-0123 rows.
  v_demo := coalesce(v_demo, false) or public.fn_is_marketer_account(v_user);

  if v_status <> 'open' then
    if v_demo then select demo_balance into v_bal from wallets where user_id = v_user;
    else select real_balance into v_bal from wallets where user_id = v_user; end if;
    return query select false, v_bal; return;
  end if;

  update positions set status='settled', exit_rate=p_exit_rate, result=p_result,
    multiplier = nullif(p_multiplier, 0), payout = p_payout, pnl = p_payout - v_stake, settled_at = now()
   where id = p_position;

  if v_demo then
    if p_payout > 0 then
      update wallets set demo_balance = demo_balance + p_payout where user_id = v_user
        returning demo_balance into v_bal;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
        values (v_user, v_site, 'payout', p_payout, 'demo', 'positions', p_position::text);
    else
      select demo_balance into v_bal from wallets where user_id = v_user;
    end if;
    return query select true, v_bal; return;
  end if;

  if p_payout > 0 then
    update wallets set real_balance = real_balance + p_payout where user_id = v_user;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (v_user, v_site, 'payout', p_payout, 'real', 'positions', p_position::text);
  end if;

  for v_bonus in
    select id, amount, wagering_x, wagered from bonuses
     where user_id = v_user and status = 'active'
       and wagered >= floor(amount * wagering_x)
     order by created_at for update
  loop
    select bonus_balance into v_convert from wallets where user_id = v_user;
    v_convert := least(v_convert, v_bonus.amount);
    if v_convert > 0 then
      update wallets set bonus_balance = bonus_balance - v_convert,
                         real_balance  = real_balance  + v_convert
       where user_id = v_user;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (v_user, v_site, 'bonus', v_convert, 'real', 'bonuses', v_bonus.id::text,
                jsonb_build_object('kind', 'wagering_conversion', 'wagered', v_bonus.wagered,
                                   'required', floor(v_bonus.amount * v_bonus.wagering_x)));
    end if;
    update bonuses set status = 'cleared', converted_at = now() where id = v_bonus.id;
  end loop;

  select real_balance into v_bal from wallets where user_id = v_user;
  return query select true, v_bal;
end;
$function$;

-- ── 9. Reporting isolation: a demo-mode position of a REAL user must leave the real cohort and join
--       the demo cohort (marketers already classified by identity; now also by the position flag). ──
create or replace view public.v_real_positions as
  select id, user_id, game_day_id, direction, stake, entry_rate, exit_rate, multiplier, payout, pnl,
         result, duration_s, status, nonce, opened_at, settled_at, config_version, site_id
    from positions po
   where not (user_id in (select user_id from marketer_account_ids))
     and demo = false;

create or replace view public.v_demo_positions as
  select id, user_id, game_day_id, direction, stake, entry_rate, exit_rate, multiplier, payout, pnl,
         result, duration_s, status, nonce, opened_at, settled_at, config_version, site_id
    from positions po
   where (user_id in (select user_id from marketer_account_ids))
      or demo = true;

commit;
