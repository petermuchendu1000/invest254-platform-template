CREATE OR REPLACE FUNCTION public.fn_affiliate_request_payout(p_user uuid)
 RETURNS TABLE(payout_id uuid, amount bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_available bigint; v_payout uuid;
begin
  if exists (select 1 from affiliate_payouts ap
              where ap.affiliate_id = p_user and ap.status in ('requested','approved')) then
    raise exception 'PAYOUT_PENDING';
  end if;
  -- lock the unreserved accrued buckets so a concurrent request can't double-claim them
  perform 1 from affiliate_commissions ac
    where ac.affiliate_id = p_user and ac.status = 'accrued' and ac.payout_id is null
    for update;
  select coalesce(sum(ac.commission), 0)::bigint into v_available
    from affiliate_commissions ac
   where ac.affiliate_id = p_user and ac.status = 'accrued' and ac.payout_id is null;
  if v_available <= 0 then raise exception 'NO_AVAILABLE_COMMISSION'; end if;
  insert into affiliate_payouts (affiliate_id, amount, status)
    values (p_user, v_available, 'requested') returning id into v_payout;
  update affiliate_commissions ac set payout_id = v_payout
   where ac.affiliate_id = p_user and ac.status = 'accrued' and ac.payout_id is null;
  return query select v_payout, v_available;
end;
$function$

