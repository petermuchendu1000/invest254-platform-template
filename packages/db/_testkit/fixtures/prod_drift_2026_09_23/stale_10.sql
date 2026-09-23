CREATE OR REPLACE FUNCTION public.fn_affiliate_payout_complete(p_payout uuid, p_result_code integer, p_conversation text, p_receipt text, p_raw jsonb)
 RETURNS TABLE(applied boolean, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  select ap.status into v_status from affiliate_payouts ap where ap.id = p_payout for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_status in ('paid','rejected') then return query select false, v_status; return; end if;
  if p_result_code = 0 then
    update affiliate_payouts ap set status = 'paid', paid_at = now(), conversation_id = p_conversation,
           mpesa_receipt = p_receipt, result_code = p_result_code, raw_callback = p_raw where ap.id = p_payout;
    update affiliate_commissions c set status = 'paid' where c.payout_id = p_payout;
    return query select true, 'paid'; return;
  else
    update affiliate_payouts ap set status = 'rejected', conversation_id = p_conversation,
           result_code = p_result_code, raw_callback = p_raw where ap.id = p_payout;
    update affiliate_commissions c set payout_id = null where c.payout_id = p_payout;
    return query select true, 'rejected'; return;
  end if;
end;
$function$

