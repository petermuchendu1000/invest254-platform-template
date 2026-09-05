-- 0113_contract_positions.sql — Phase 2: digit + multiplier contracts on the positions table.
--
-- Extends `positions` with:
--   • kind  — 'rise_fall' (default; the existing curve game, unchanged) | 'digit' | 'multiplier'
--   • contract jsonb — the per-kind parameters (digit: market/outcome/barrier; multiplier:
--     dir/multiplier/tp/sl/deal-cancellation).
--
-- Adds fn_open_contract: the money movement is IDENTICAL to fn_open_position (0094) — brand stake
-- bounds, demo vs real+bonus-first staking, wagering accrual, and the same ledger_entries — it only
-- ADDITIONALLY records `kind` + `contract`. Digit contracts pass a placeholder direction ('buy')
-- and duration_s=1 (1 tick); multipliers map up→'buy', down→'sell'. The authoritative semantics live
-- in `contract`.
--
-- Settlement REUSES fn_settle_position UNCHANGED — it already takes (result, payout) and is
-- contract-agnostic (demo/real + bonus conversion + ledger). The engine computes the outcome/payout
-- via @invest254/shared `contracts.ts` (provably fair: the last digit is the final digit of the
-- seed-derived quote) and calls it.
--
-- ADDITIVE + UNWIRED: existing inserts default kind='rise_fall'; nothing calls fn_open_contract yet,
-- so this has zero runtime effect until the engine/web increments consume it. Idempotent.

alter table public.positions add column if not exists kind text not null default 'rise_fall';
alter table public.positions add column if not exists contract jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'positions_kind_chk') then
    alter table public.positions add constraint positions_kind_chk check (kind in ('rise_fall','digit','multiplier'));
  end if;
end $$;

create or replace function public.fn_open_contract(
  p_user uuid, p_stake bigint, p_kind text, p_contract jsonb, p_direction text, p_entry_rate numeric,
  p_duration_s int, p_game_day bigint, p_nonce bigint, p_opened_at timestamptz,
  p_config_version bigint, p_site_id uuid
) returns table(position_id uuid, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_id uuid; v_min bigint; v_max bigint; v_demo boolean;
        v_real bigint; v_bonus bigint; v_from_bonus bigint; v_from_real bigint;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_kind not in ('rise_fall','digit','multiplier') then raise exception 'INVALID_KIND'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;
  if p_duration_s <= 0 then raise exception 'INVALID_DURATION'; end if;

  -- Live stake bounds for THIS brand (defence in depth; last gate before money moves).
  select min_stake, max_stake into v_min, v_max from site_game_config where site_id = p_site_id;
  if v_min is not null and p_stake < v_min then raise exception 'STAKE_BELOW_MIN'; end if;
  if v_max is not null and p_stake > v_max then raise exception 'STAKE_ABOVE_MAX'; end if;

  v_demo := public.fn_is_marketer_account(p_user);      -- authoritative, server-side (unspoofable)

  if v_demo then
    -- Demo/marketer path: demo_balance only; no bonus, no wagering (mirrors fn_open_position).
    select demo_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = demo_balance - p_stake where user_id = p_user
      returning demo_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version, kind, contract)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version, p_kind, p_contract);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text);
    return query select v_id, v_bal;
    return;
  end if;

  -- Real player path: bonus-first staking + wagering accrual (mirrors fn_open_position).
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
                        status, nonce, opened_at, config_version, kind, contract)
    values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
            'open', p_nonce, p_opened_at, p_config_version, p_kind, p_contract);
  if v_from_real > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_real, 'real', 'positions', v_id::text);
  end if;
  if v_from_bonus > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_bonus, 'bonus', 'positions', v_id::text);
  end if;
  -- Wagering progress: every staked shilling (real + bonus) counts toward this user's active bonuses.
  update bonuses set wagered = wagered + p_stake
   where user_id = p_user and status = 'active';

  return query select v_id, v_bal;   -- new_balance = remaining REAL (spendable/withdrawable) balance
end;
$fn$;

revoke all on function public.fn_open_contract(uuid,bigint,text,jsonb,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) from public;
grant  execute on function public.fn_open_contract(uuid,bigint,text,jsonb,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) to service_role;
