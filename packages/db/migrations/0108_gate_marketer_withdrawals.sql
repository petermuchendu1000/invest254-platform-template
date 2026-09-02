-- 0108_gate_marketer_withdrawals.sql — require admin approval for marketer (internal-rail) withdrawals.
--
-- BEFORE: fn_marketer_game_withdraw paid instantly — it debited the account's demo balance AND
-- credited the marketer M-Pesa wallet in one call, writing a transaction already status='success'
-- (provider='internal'). No admin step; these rows were also hidden from the moderation queue.
--
-- AFTER (Issue 1 — "receive all withdrawal requests with Approve/Reject"): the marketer cash-out is
-- HELD as a pending request. The demo balance is still debited immediately (so the funds can't be
-- double-spent), but the marketer wallet is NOT credited until an admin APPROVES. Reject refunds the
-- held demo balance. This mirrors the classic M-Pesa hold→approve/reject lifecycle.
--
-- Three functions are redefined (same signatures, so existing grants persist):
--   fn_marketer_game_withdraw  -> create a PENDING internal withdrawal (hold demo, no credit)
--   fn_approve_withdrawal      -> branch by rail: internal => credit marketer wallet + settle success;
--                                 mpesa => flip to 'processing' (engine then dispatches B2C, unchanged)
--   fn_reject_withdrawal       -> branch by rail: internal => refund demo bucket; mpesa => refund real
-- Idempotent + safe to re-apply.

-- ── 1. HOLD (no credit) ─────────────────────────────────────────────────────────────────────────
create or replace function public.fn_marketer_game_withdraw(p_user uuid, p_amount bigint)
 returns table(is_marketer boolean, tx_id uuid, new_balance bigint, mpesa_balance bigint)
 language plpgsql security definer set search_path = 'public'
as $function$
declare v_phone text; v_pstatus text; v_mid uuid; v_mstatus text; v_bal bigint; v_id uuid; v_mpesa bigint;
begin
  select phone, status into v_phone, v_pstatus from profiles where id = p_user;
  if v_phone is null then raise exception 'WALLET_NOT_FOUND'; end if;

  -- canonical cohort match (same rule as fn_is_marketer_account / marketer_account_ids)
  select id, status into v_mid, v_mstatus from marketers
    where public.fn_phone_sig9(phone) = public.fn_phone_sig9(v_phone)
      and length(public.fn_phone_sig9(v_phone)) = 9
    order by id limit 1;
  if v_mid is null then
    return query select false, null::uuid, null::bigint, null::bigint;
    return;
  end if;
  if v_pstatus is distinct from 'active' or v_mstatus is distinct from 'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select demo_balance into v_bal from wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  -- Hold: debit demo now so the amount can't be re-spent while the request is pending.
  update wallets set demo_balance = demo_balance - p_amount where user_id = p_user returning demo_balance into v_bal;

  -- PENDING (was 'success'): the marketer wallet is credited only on admin approval.
  insert into transactions(user_id, kind, amount, status, provider, phone)
    values (p_user, 'withdrawal', p_amount, 'pending', 'internal', public.fn_phone_sig9(v_phone)) returning id into v_id;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, 'withdrawal', -p_amount, 'demo', 'transactions', v_id::text);

  -- Report the marketer wallet balance UNCHANGED (nothing credited yet).
  select balance_cents into v_mpesa from marketer_wallets where marketer_id = v_mid;
  return query select true, v_id, v_bal, coalesce(v_mpesa, 0);
end;
$function$;

-- ── 2. APPROVE (branch by rail) ─────────────────────────────────────────────────────────────────
create or replace function public.fn_approve_withdrawal(p_tx uuid, p_admin uuid)
returns boolean language plpgsql security definer set search_path = public
as $fn$
declare v_tx public.transactions%rowtype; v_mid uuid;
begin
  select * into v_tx from transactions where id = p_tx and kind = 'withdrawal' for update;
  if not found then return false; end if;
  if v_tx.status <> 'pending' then return false; end if;

  if v_tx.provider = 'internal' then
    -- Marketer rail: NOW credit the marketer M-Pesa wallet and settle. Idempotent on ref 'game:<tx>'.
    select id into v_mid from marketers
      where public.fn_phone_sig9(phone) = v_tx.phone and length(v_tx.phone) = 9
      order by id limit 1;
    if v_mid is null then raise exception 'MARKETER_NOT_FOUND'; end if;
    perform public.fn_marketer_credit(v_mid, v_tx.amount, 'game:'||v_tx.id::text,
              jsonb_build_object('source','game_withdrawal_approved','tx', v_tx.id::text, 'approved_by', p_admin));
    update transactions set status = 'success', approved_by = p_admin where id = v_tx.id;
    return true;
  end if;

  -- M-Pesa rail (unchanged): flip to processing; the engine dispatches the B2C payout.
  update transactions set status = 'processing', approved_by = p_admin where id = v_tx.id;
  return true;
end;
$fn$;

-- ── 3. REJECT (branch refund bucket) ──────────────────────────────────────────────────────────────
create or replace function public.fn_reject_withdrawal(p_tx uuid, p_admin uuid)
returns table(reversed boolean, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_tx public.transactions%rowtype; v_bal bigint;
begin
  select * into v_tx from transactions where id = p_tx and kind = 'withdrawal' for update;
  if not found then raise exception 'TX_NOT_FOUND'; end if;
  if v_tx.status <> 'pending' then
    select coalesce(real_balance,0) into v_bal from wallets where user_id = v_tx.user_id limit 1;
    return query select false, coalesce(v_bal,0); return;
  end if;

  update transactions set status = 'reversed', approved_by = p_admin where id = v_tx.id;

  if v_tx.provider = 'internal' then
    -- Refund the held DEMO balance (mirrors the hold in fn_marketer_game_withdraw).
    update wallets set demo_balance = demo_balance + v_tx.amount where user_id = v_tx.user_id
      returning demo_balance into v_bal;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (v_tx.user_id, v_tx.site_id, 'withdrawal_reversal', v_tx.amount, 'demo', 'transactions', v_tx.id::text);
    return query select true, v_bal;
    return;
  end if;

  -- M-Pesa rail (unchanged): refund the held REAL balance.
  update wallets set real_balance = real_balance + v_tx.amount where user_id = v_tx.user_id
    returning real_balance into v_bal;
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
    values (v_tx.user_id, v_tx.site_id, 'withdrawal_reversal', v_tx.amount, 'real', 'transactions', v_tx.id::text);
  return query select true, v_bal;
end;
$fn$;
