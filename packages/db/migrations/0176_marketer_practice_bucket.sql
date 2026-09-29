-- 0176_marketer_practice_bucket.sql — a marketer's Demo tab = a REAL, separate, playable practice bucket.
--
-- WHY: a marketer must be indistinguishable from a player (docs/51 §7, DEMO-5). A player has a Real
-- account and a separate Demo practice account; a marketer's "Real" is their funny money
-- (wallets.demo_balance), withdrawn via the instant marketer transfer. Until now they had NO second
-- bucket, so their Demo tab could only be a dead label. This adds a genuinely separate practice bucket
-- a marketer can switch into, top up, and play — never withdrawable, never real cash.
--
-- SHAPE (deliberately additive + isolated so real players are byte-for-byte unaffected):
--   * wallets.practice_balance  — the new bucket. Nothing else reads or writes it, so it cannot leak
--                                 into real cash, deposits, withdrawals, bonuses or reporting.
--   * wallets.marketer_practice — the marketer's Real/Demo switch. account_mode is left UNTOUCHED
--                                 ('demo' for a marketer, as before), so pool exemption
--                                 (fn_account_is_demo), the funny-money path and reporting are exactly
--                                 as they were. This flag ONLY redirects a marketer's play/top-up.
--   * positions.practice        — the bucket a position was staked from, decided AT OPEN, so settlement
--                                 routes by it (never by identity at settle time).
--
-- The ONLY new code path in the betting/settlement RPCs is "marketer AND marketer_practice" — guarded
-- by fn_is_marketer_account, so a non-marketer, and a marketer on their funny money, are unchanged.
--
-- INVARIANTS (unchanged, still enforced): a marketer never withdraws real cash
-- (fn_create_withdrawal refuses them; practice_balance is never a withdrawal source); marketer play is
-- always pool-exempt (fn_account_is_demo stays true via the marketer clause); marketer positions stay
-- out of the real cohort by IDENTITY (v_real_positions excludes marketer_account_ids), so a
-- practice position (demo=false) is still excluded.
--
-- Additive + idempotent + revertible (new columns default to a no-op state).

begin;

-- ── 1. The new bucket, the switch, and the position tag. Defaults keep every existing account and
--       every existing row in its current behaviour until a marketer explicitly enters practice. ──────
alter table public.wallets
  add column if not exists practice_balance bigint not null default 0,
  add column if not exists marketer_practice boolean not null default false;

alter table public.positions
  add column if not exists practice boolean not null default false;

create index if not exists idx_positions_practice on public.positions(site_id, practice) where practice;

-- ── 2. Toggle a marketer into / out of practice mode. Marketer-only (a non-marketer is a no-op that
--       returns false and changes nothing). account_mode is NOT touched. Refuses while a contract is
--       open, so a trade can never straddle a bucket switch (mirrors fn_set_account_mode's API guard). ─
create or replace function public.fn_set_marketer_practice(p_user uuid, p_site_id uuid, p_on boolean)
 returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare v_on boolean := coalesce(p_on, false);
begin
  if not public.fn_is_marketer_account(p_user) then return false; end if;
  if exists (select 1 from public.positions where user_id = p_user and status = 'open') then
    raise exception 'OPEN_POSITIONS';
  end if;
  update public.wallets set marketer_practice = v_on, updated_at = now()
    where user_id = p_user and site_id = p_site_id;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  return v_on;
end;
$$;
revoke all on function public.fn_set_marketer_practice(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.fn_set_marketer_practice(uuid,uuid,boolean) to service_role;

-- Small helper: is this marketer currently in practice mode? Keeps the betting RPCs readable and the
-- predicate in ONE place.
create or replace function public.fn_marketer_in_practice(p_user uuid, p_site_id uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select public.fn_is_marketer_account(p_user)
     and coalesce((select marketer_practice from public.wallets
                    where user_id = p_user and site_id = p_site_id), false);
$$;

-- ── 3. fn_open_position (rise/fall): PREPEND the marketer-practice branch; the demo and real branches
--       below are byte-for-byte the 0123 bodies. ─────────────────────────────────────────────────────
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

  -- MARKETER PRACTICE: stakes the separate practice bucket, never the funny money (their Real). Tagged
  -- practice=true so settlement pays it back here. Guarded by identity => no other account is affected.
  if public.fn_marketer_in_practice(p_user, p_site_id) then
    select practice_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set practice_balance = practice_balance - p_stake
      where user_id = p_user and site_id = p_site_id returning practice_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version, demo, practice)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version, false, true);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text,
              jsonb_build_object('bucket', 'practice'));
    return query select v_id, v_bal;
    return;
  end if;

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

-- ── 4. fn_open_contract (digit/multiplier/rise_fall): same PREPEND; the rest is the 0123 body. ───────
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

  -- MARKETER PRACTICE (see fn_open_position): the separate practice bucket, never the funny money.
  if public.fn_marketer_in_practice(p_user, p_site_id) then
    select practice_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set practice_balance = practice_balance - p_stake
      where user_id = p_user and site_id = p_site_id returning practice_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version, kind, contract, demo, practice)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version, p_kind, p_contract, false, true);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text,
              jsonb_build_object('bucket', 'practice'));
    return query select v_id, v_bal;
    return;
  end if;

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

-- ── 5. fn_settle_position: PREPEND practice settlement (routed by positions.practice, decided at open)
--       so the marketer-identity fallback below can never divert a practice payout to funny money. The
--       demo and real branches are the 0123 bodies, unchanged. ─────────────────────────────────────
create or replace function public.fn_settle_position(p_position uuid, p_exit_rate numeric, p_result text, p_multiplier numeric, p_payout bigint)
 returns table(settled boolean, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_status text; v_user uuid; v_stake bigint; v_bal bigint; v_site uuid; v_demo boolean;
        v_practice boolean; v_bonus record; v_convert bigint;
begin
  if p_result not in ('win','loss','void') then raise exception 'INVALID_RESULT'; end if;
  if p_payout < 0 then raise exception 'INVALID_PAYOUT'; end if;
  select status, user_id, stake, site_id, demo, practice
    into v_status, v_user, v_stake, v_site, v_demo, v_practice
    from positions where id = p_position for update;
  if not found then raise exception 'POSITION_NOT_FOUND'; end if;

  -- PRACTICE position: settles the practice bucket it was staked from. Checked first so the marketer
  -- fallback (below) cannot pay a practice win into the funny-money (demo) bucket.
  if coalesce(v_practice, false) then
    if v_status <> 'open' then
      select practice_balance into v_bal from wallets where user_id = v_user;
      return query select false, v_bal; return;
    end if;
    update positions set status='settled', exit_rate=p_exit_rate, result=p_result,
      multiplier = nullif(p_multiplier, 0), payout = p_payout, pnl = p_payout - v_stake, settled_at = now()
     where id = p_position;
    if p_payout > 0 then
      update wallets set practice_balance = practice_balance + p_payout where user_id = v_user
        returning practice_balance into v_bal;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (v_user, v_site, 'payout', p_payout, 'demo', 'positions', p_position::text,
                jsonb_build_object('bucket', 'practice'));
    else
      select practice_balance into v_bal from wallets where user_id = v_user;
    end if;
    return query select true, v_bal; return;
  end if;

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

-- ── 6. fn_topup_demo_account: a marketer in practice tops up the PRACTICE bucket; everyone else the
--       demo bucket exactly as in 0169. Same signature, so the API's two-/three-arg callers are unchanged. ─
drop function if exists public.fn_topup_demo_account(uuid, uuid, bigint);
create or replace function public.fn_topup_demo_account(p_user uuid, p_site_id uuid, p_target bigint default 1000000)
 returns bigint language plpgsql security definer set search_path to 'public'
as $$
declare v_target bigint := coalesce(p_target, 1000000); v_bal bigint; v_new bigint;
begin
  if v_target < 100000 or v_target > 10000000000 then raise exception 'INVALID_AMOUNT'; end if;  -- KES 1,000 .. KES 100M
  if public.fn_marketer_in_practice(p_user, p_site_id) then
    select practice_balance into v_bal from public.wallets
      where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal >= v_target then return v_bal; end if;         -- already funded -> no-op (can't be farmed)
    update public.wallets set practice_balance = v_target, updated_at = now()
      where user_id = p_user and site_id = p_site_id returning practice_balance into v_new;
    insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_user, p_site_id, 'adjustment', v_target - v_bal, 'demo', null, null,
              jsonb_build_object('reason', 'self_topup_practice'));
    return v_new;
  end if;
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
revoke all on function public.fn_topup_demo_account(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.fn_topup_demo_account(uuid,uuid,bigint) to service_role;

commit;
