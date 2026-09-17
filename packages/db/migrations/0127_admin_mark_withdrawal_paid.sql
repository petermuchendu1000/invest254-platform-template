-- 0127_admin_mark_withdrawal_paid.sql — let an admin manually finalize a withdrawal as PAID when the
-- automated rail (Daraja / Mega Pay B2C) never delivered its result callback (BUGLOG #32).
--
-- Problem: a withdrawal debits the wallet at creation (fn_create_withdrawal), flips to 'processing' on
-- approval (B2C dispatched), and only reaches 'success' when the provider's async result callback
-- arrives (fn_complete_withdrawal, result_code=0). When that callback never lands (a known Mega Pay /
-- Daraja failure mode) the row is stranded in 'processing' forever — the money already left the wallet,
-- the player was paid out-of-band, yet the client shows "processing" indefinitely and there is no admin
-- action to finalize it. (4 live rows were stuck like this.)
--
-- Fix: fn_admin_mark_withdrawal_paid transitions a pending/processing withdrawal to 'success' with a
-- manual receipt + an immutable admin_actions audit row. It makes NO wallet change (the money was
-- already debited at create — marking paid only records that the payout completed), so the client then
-- reflects the withdrawal as paid. It is idempotent on an already-paid row and REFUSES a failed/reversed
-- row (that money was returned to the wallet — paying now would double-pay). Auth/site-scope are enforced
-- by the API route (requireRole('admin') + assertTargetSiteInScope on the tx's brand + the superadmin
-- approval-password gate), exactly like approve/reject — this RPC is the money-atomic executor.

create or replace function public.fn_admin_mark_withdrawal_paid(p_tx uuid, p_admin uuid, p_receipt text)
returns table(applied boolean, status text, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_tx public.transactions%rowtype; v_bal bigint; v_actor_role text; v_receipt text;
begin
  select * into v_tx from transactions where id = p_tx and kind = 'withdrawal' for update;
  if not found then raise exception 'TX_NOT_FOUND'; end if;

  select real_balance into v_bal from wallets where user_id = v_tx.user_id and site_id = v_tx.site_id;

  -- Idempotent: already paid -> no-op (safe to click twice / bulk re-run).
  if v_tx.status = 'success' then
    return query select false, 'success', v_bal; return;
  end if;
  -- A failed/reversed withdrawal already RE-CREDITED the wallet; marking it paid now would pay twice.
  if v_tx.status in ('failed', 'reversed') then
    raise exception 'WITHDRAWAL_ALREADY_REVERSED';
  end if;

  -- pending | processing -> finalize as PAID. The money was debited at create (hold), so there is NO
  -- wallet movement here; we only record the terminal state + a manual receipt + who did it.
  v_receipt := coalesce(nullif(btrim(p_receipt), ''), 'MANUAL-' || upper(left(replace(p_tx::text, '-', ''), 10)));
  select role into v_actor_role from public.profiles where id = p_admin;

  update public.transactions
     set status        = 'success',
         result_code   = 0,
         result_desc   = 'Manually marked paid by admin',
         mpesa_receipt = v_receipt,
         approved_by   = coalesce(approved_by, p_admin),
         raw_callback  = jsonb_build_object('manual', true, 'marked_paid_by', p_admin, 'marked_at', now(),
                                            'prev_status', v_tx.status,
                                            'note', 'payout confirmed out-of-band; automated callback did not arrive'),
         updated_at    = now()
   where id = v_tx.id;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_admin, coalesce(v_actor_role, 'admin'), 'withdrawal.mark_paid', 'transaction', v_tx.id::text,
            jsonb_build_object('amount', v_tx.amount, 'phone', v_tx.phone,
                               'prev_status', v_tx.status, 'receipt', v_receipt), v_tx.site_id);

  return query select true, 'success', v_bal;
end;
$fn$;

revoke all on function public.fn_admin_mark_withdrawal_paid(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.fn_admin_mark_withdrawal_paid(uuid,uuid,text) to service_role;
