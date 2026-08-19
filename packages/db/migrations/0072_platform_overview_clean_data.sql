-- 0072_platform_overview_clean_data.sql
-- Clean platform-console data: exclude the internal MARKETER cohort from real-player KPIs.
--
-- Problem: the per-brand admin/finance reports (engine/src/admin.ts) already exclude the marketer
-- funny-money cohort (`marketer_account_ids`, migration 0070) from real-player deposits / withdrawals
-- / turnover / GGR / wallet-liability / player counts. But the cross-brand PLATFORM console
-- (`fn_platform_overview`) did NOT — so the platform Overview + performance figures were inflated by
-- internally-credited marketer play. On invest254 this distorted platform GGR by ~4.8M KES
-- (settled marketer play on non-real balance). This aligns the platform console with the same clean
-- definition the finance page uses, so real-player numbers are consistent system-wide.
--
-- Changes (all in fn_platform_overview): real-player selects now exclude
--   `user_id in (select user_id from marketer_account_ids)`, and withdrawals additionally exclude
--   internal transfers (`provider = 'internal'`, the marketer game-winnings rail, migration 0036) so
--   the number matches admin.ts exactly. Read-only, additive, idempotent; contract (columns) unchanged.

create or replace function public.fn_platform_overview(p_actor_role text)
 returns table(site_id uuid, slug text, name text, status text, users bigint, deposits_cents bigint,
               withdrawals_cents bigint, ggr_cents bigint, open_positions bigint, bets bigint)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select s.id, s.slug, s.name, s.status,
           coalesce(u.n, 0)::bigint,
           coalesce(d.amt, 0)::bigint,
           coalesce(w.amt, 0)::bigint,
           coalesce(p.ggr, 0)::bigint,
           coalesce(p.open_n, 0)::bigint,
           coalesce(p.bet_n, 0)::bigint
      from public.sites s
      left join lateral (select count(*) n from public.profiles pr
                          where pr.site_id = s.id
                            and pr.id not in (select user_id from public.marketer_account_ids)) u on true
      left join lateral (select coalesce(sum(amount),0) amt from public.transactions t
                          where t.site_id = s.id and t.kind='deposit' and t.status='success'
                            and t.user_id not in (select user_id from public.marketer_account_ids)) d on true
      left join lateral (select coalesce(sum(amount),0) amt from public.transactions t
                          where t.site_id = s.id and t.kind='withdrawal' and t.status='success'
                            and t.provider is distinct from 'internal'
                            and t.user_id not in (select user_id from public.marketer_account_ids)) w on true
      left join lateral (select coalesce(sum(stake - payout) filter (where po.status='settled'),0) ggr,
                                count(*) filter (where po.status='open')    open_n,
                                count(*) filter (where po.status='settled') bet_n
                           from public.positions po
                          where po.site_id = s.id
                            and po.user_id not in (select user_id from public.marketer_account_ids)) p on true
     order by s.created_at asc;
end;
$function$;
