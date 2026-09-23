CREATE OR REPLACE FUNCTION public.fn_affiliate_payout_approve(p_payout uuid, p_admin uuid)
 RETURNS TABLE(approved boolean, amount bigint, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aff uuid; v_amt bigint; v_status text; v_phone text;
begin
  select ap.affiliate_id, ap.amount, ap.status into v_aff, v_amt, v_status
    from affiliate_payouts ap where ap.id = p_payout for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_status <> 'requested' then return query select false, null::bigint, null::text; return; end if;
  update affiliate_payouts ap set status = 'approved', approved_by = p_admin where ap.id = p_payout;
  select pr.phone into v_phone from profiles pr where pr.id = v_aff;
  return query select true, v_amt, v_phone;
end;
$function$

