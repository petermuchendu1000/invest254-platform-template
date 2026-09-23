CREATE OR REPLACE FUNCTION public.fn_affiliate_payout_request(p_affiliate uuid)
 RETURNS TABLE(payout_id uuid, amount bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_amount bigint; v_id uuid;
begin
  if not exists (select 1 from affiliates a where a.user_id = p_affiliate) then raise exception 'NOT_AFFILIATE'; end if;
  if exists (select 1 from affiliate_payouts ap where ap.affiliate_id = p_affiliate and ap.status in ('requested','approved')) then
    raise exception 'PAYOUT_PENDING';
  end if;
  select coalesce(sum(c.commission), 0) into v_amount
    from affiliate_commissions c
   where c.affiliate_id = p_affiliate and c.status = 'accrued' and c.payout_id is null;
  if v_amount <= 0 then raise exception 'NO_COMMISSION'; end if;
  insert into affiliate_payouts(affiliate_id, amount, status) values (p_affiliate, v_amount, 'requested')
    returning id into v_id;
  update affiliate_commissions c set payout_id = v_id
   where c.affiliate_id = p_affiliate and c.status = 'accrued' and c.payout_id is null;
  return query select v_id, v_amount;
end;
$function$

