CREATE OR REPLACE FUNCTION public.fn_affiliate_payout_reject(p_payout uuid, p_admin uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  select ap.status into v_status from affiliate_payouts ap where ap.id = p_payout for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_status <> 'requested' then return false; end if;
  update affiliate_payouts ap set status = 'rejected', approved_by = p_admin where ap.id = p_payout;
  update affiliate_commissions c set payout_id = null where c.payout_id = p_payout;
  return true;
end;
$function$

