CREATE OR REPLACE FUNCTION public.fn_open_position(p_user uuid, p_stake bigint, p_direction text, p_entry_rate numeric, p_duration_s integer, p_game_day bigint, p_nonce bigint)
 RETURNS TABLE(position_id uuid, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_real bigint; v_bonus bigint; v_from_bonus bigint; v_from_real bigint; v_id uuid;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;
  select real_balance, bonus_balance into v_real, v_bonus
    from wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_real + v_bonus < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
  v_from_bonus := least(v_bonus, p_stake);
  v_from_real  := p_stake - v_from_bonus;
  update wallets set bonus_balance = bonus_balance - v_from_bonus,
                     real_balance  = real_balance  - v_from_real
   where user_id = p_user returning real_balance into v_real;
  v_id := gen_random_uuid();
  -- committed outcome intentionally NOT stored (player cannot read result pre-settle)
  insert into positions(id, user_id, game_day_id, direction, stake, entry_rate, duration_s, status, nonce)
    values (v_id, p_user, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s, 'open', p_nonce);
  if v_from_real > 0 then
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, 'stake', -v_from_real, 'real', 'positions', v_id::text);
  end if;
  if v_from_bonus > 0 then
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, 'stake', -v_from_bonus, 'bonus', 'positions', v_id::text);
  end if;
  -- wagering progress: every staked shilling counts toward active bonuses (FIFO)
  update bonuses set wagered = wagered + p_stake
   where user_id = p_user and status = 'active';
  return query select v_id, v_real;
end;
$function$

