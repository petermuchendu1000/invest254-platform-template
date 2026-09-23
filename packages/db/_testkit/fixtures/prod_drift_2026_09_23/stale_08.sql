CREATE OR REPLACE FUNCTION public.fn_accrue_affiliate_commissions(p_period date)
 RETURNS TABLE(buckets integer, total_commission bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_buckets integer; v_total bigint;
begin
  with ggr as (
    select pr.referred_by as affiliate_id,
           p.user_id       as referred_user,
           greatest(0, sum(p.stake - p.payout))::bigint as ggr
      from positions p
      join profiles  pr on pr.id = p.user_id
      join game_days gd on gd.id = p.game_day_id
     where p.status = 'settled'
       and gd.trade_date = p_period
       and pr.referred_by is not null
     group by pr.referred_by, p.user_id
  ),
  upserted as (
    insert into affiliate_commissions (affiliate_id, referred_user, period, ggr, commission, status)
    select g.affiliate_id, g.referred_user, p_period, g.ggr,
           floor(g.ggr * a.commission_rate)::bigint, 'accrued'
      from ggr g
      join affiliates a on a.user_id = g.affiliate_id
     where g.ggr > 0
    on conflict (affiliate_id, referred_user, period) do update
      set ggr = excluded.ggr, commission = excluded.commission
      where affiliate_commissions.status = 'accrued'
    returning commission
  )
  select count(*)::integer, coalesce(sum(commission), 0)::bigint into v_buckets, v_total from upserted;
  return query select v_buckets, v_total;
end;
$function$

