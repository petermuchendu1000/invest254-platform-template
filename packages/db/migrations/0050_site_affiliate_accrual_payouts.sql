-- 0050_site_affiliate_accrual_payouts.sql — site-scope the affiliate accrual + payout (docs/22 Task B).
--
-- Closes the last Task B item: "fn_accrue_affiliate_commissions / payout RPCs — group GGR by
-- (site_id, affiliate_id, period)". Each affiliate belongs to exactly one brand (affiliates.site_id,
-- set at enrol) and every referred player + their positions live on that same brand, so the fix is:
--   1. STAMP `site_id` on every commission bucket and payout.
--   2. Make the bucket unique `(site_id, affiliate_id, referred_user, period)`.
--   3. Only ever accrue an affiliate for GGR earned on THEIR OWN brand (join affiliate.site = position.site).
--   4. Let an operator accrue ONE brand (`p_site_id`) or all brands (null = platform cron, default).
--   5. Scope a payout's available-commission + reservation to the affiliate's brand.
--
-- Additive + idempotent. The deployed 1-arg `fn_accrue_affiliate_commissions(date)` call keeps
-- working: the old arity is dropped and the new 2-arg version defaults `p_site_id` to null (all
-- brands), so a 1-arg call resolves to it unambiguously.

-- ── 1. Backfill site_id on any legacy commission/payout rows from the affiliate's brand ──────────
update public.affiliate_commissions ac
   set site_id = coalesce(a.site_id, '00000000-0000-0000-0000-000000000001')
  from public.affiliates a
 where a.user_id = ac.affiliate_id and ac.site_id is distinct from coalesce(a.site_id, '00000000-0000-0000-0000-000000000001');
update public.affiliate_payouts ap
   set site_id = coalesce(a.site_id, '00000000-0000-0000-0000-000000000001')
  from public.affiliates a
 where a.user_id = ap.affiliate_id and ap.site_id is distinct from coalesce(a.site_id, '00000000-0000-0000-0000-000000000001');

-- ── 2. Bucket unique now carries the brand ───────────────────────────────────────────────────────
drop index if exists public.uq_commission_bucket;
create unique index uq_commission_bucket
  on public.affiliate_commissions (site_id, affiliate_id, referred_user, period);

-- ── 3. Site-aware accrual (per-brand or all-brands) ──────────────────────────────────────────────
drop function if exists public.fn_accrue_affiliate_commissions(date);
create or replace function public.fn_accrue_affiliate_commissions(p_period date, p_site_id uuid default null)
returns table(buckets integer, total_commission bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_buckets integer; v_total bigint;
begin
  with ggr as (
    select pr.referred_by as affiliate_id,
           p.user_id       as referred_user,
           p.site_id       as site_id,
           greatest(0, sum(p.stake - p.payout))::bigint as ggr
      from positions p
      join profiles  pr on pr.id = p.user_id
      join game_days gd on gd.id = p.game_day_id
     where p.status = 'settled'
       and gd.trade_date = p_period
       and pr.referred_by is not null
       and (p_site_id is null or p.site_id = p_site_id)
     group by pr.referred_by, p.user_id, p.site_id
  ),
  upserted as (
    insert into affiliate_commissions (affiliate_id, referred_user, period, ggr, commission, status, site_id)
    select g.affiliate_id, g.referred_user, p_period, g.ggr,
           floor(g.ggr * a.commission_rate)::bigint, 'accrued', g.site_id
      from ggr g
      -- an affiliate is ONLY credited for GGR earned on their own brand (defence-in-depth: a
      -- referred_user always shares the affiliate's site, but this join makes cross-brand
      -- accrual structurally impossible).
      join affiliates a on a.user_id = g.affiliate_id and a.site_id = g.site_id
     where g.ggr > 0
    on conflict (site_id, affiliate_id, referred_user, period) do update
      set ggr = excluded.ggr, commission = excluded.commission
      where affiliate_commissions.status = 'accrued'   -- never touch paid/reversed buckets
    returning commission
  )
  select count(*)::integer, coalesce(sum(commission), 0)::bigint into v_buckets, v_total from upserted;
  return query select v_buckets, v_total;
end;
$fn$;

revoke all on function public.fn_accrue_affiliate_commissions(date, uuid) from public;
revoke all on function public.fn_accrue_affiliate_commissions(date, uuid) from anon;
revoke all on function public.fn_accrue_affiliate_commissions(date, uuid) from authenticated;
grant execute on function public.fn_accrue_affiliate_commissions(date, uuid) to service_role;

-- ── 4. Payout request: scope available commission + reservation + stamp to the affiliate's brand ──
create or replace function public.fn_affiliate_request_payout(p_user uuid)
returns table(payout_id uuid, amount bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_available bigint; v_payout uuid; v_site uuid;
begin
  select coalesce(a.site_id, '00000000-0000-0000-0000-000000000001') into v_site
    from affiliates a where a.user_id = p_user;
  if not found then raise exception 'NOT_AFFILIATE'; end if;

  if exists (select 1 from affiliate_payouts ap
              where ap.affiliate_id = p_user and ap.status in ('requested','approved')) then
    raise exception 'PAYOUT_PENDING';
  end if;
  -- lock this brand's unreserved accrued buckets so a concurrent request can't double-claim them
  perform 1 from affiliate_commissions ac
    where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null
    for update;
  select coalesce(sum(ac.commission), 0)::bigint into v_available
    from affiliate_commissions ac
   where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null;
  if v_available <= 0 then raise exception 'NO_AVAILABLE_COMMISSION'; end if;
  insert into affiliate_payouts (affiliate_id, amount, status, site_id)
    values (p_user, v_available, 'requested', v_site) returning id into v_payout;
  update affiliate_commissions ac set payout_id = v_payout
   where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null;
  return query select v_payout, v_available;
end;
$fn$;

revoke all on function public.fn_affiliate_request_payout(uuid) from public;
revoke all on function public.fn_affiliate_request_payout(uuid) from anon;
revoke all on function public.fn_affiliate_request_payout(uuid) from authenticated;
grant execute on function public.fn_affiliate_request_payout(uuid) to service_role;
