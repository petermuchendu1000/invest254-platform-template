-- 0101_demo_isolation_views.sql — the SINGLE canonical REAL/DEMO data boundary (docs/27).
--
-- ROOT CAUSE of report pollution: money-bearing rows (positions / ledger_entries / transactions /
-- wallets) for the MARKETER/DEMO cohort live in the SAME tables as real players. Any query that
-- forgets to exclude the marketer cohort silently mixes funny-money into real analytics (e.g. an
-- ad-hoc `sum(positions.stake)` reported millions of KES of demo turnover as if it were real).
--
-- FIX (chosen after comparing physical-separation and stamped-column+trigger designs): make the split
-- a first-class, UN-POLLUTABLE interface via real-only + demo-only VIEWS over the canonical LIVE
-- classifier `marketer_account_ids` (= profiles where fn_is_marketer_account(id); site-scoped, 0100).
--   * Correct BY CONSTRUCTION: a v_real_* view can never contain a demo row.
--   * DRIFT-FREE: the classifier is evaluated live, so reclassification (enroll/unenroll a marketer)
--     is reflected immediately — no backfill, no trigger on the money hot-path, no stale flag.
--   * SINGLE SOURCE OF TRUTH: fn_platform_overview is rewired onto the views (identical output), so
--     "real" is defined in exactly one place.
-- Additive, idempotent, money-neutral. Analytics MUST read v_real_* going forward.

-- ── Real / demo VIEWS per money-bearing table ─────────────────────────────────────────────────────
create or replace view public.v_real_profiles as
  select p.* from public.profiles p
   where p.id not in (select user_id from public.marketer_account_ids);
create or replace view public.v_demo_profiles as
  select p.* from public.profiles p
   where p.id in (select user_id from public.marketer_account_ids);

create or replace view public.v_real_positions as
  select po.* from public.positions po
   where po.user_id not in (select user_id from public.marketer_account_ids);
create or replace view public.v_demo_positions as
  select po.* from public.positions po
   where po.user_id in (select user_id from public.marketer_account_ids);

create or replace view public.v_real_ledger_entries as
  select le.* from public.ledger_entries le
   where le.user_id not in (select user_id from public.marketer_account_ids);
create or replace view public.v_demo_ledger_entries as
  select le.* from public.ledger_entries le
   where le.user_id in (select user_id from public.marketer_account_ids);

create or replace view public.v_real_transactions as
  select t.* from public.transactions t
   where t.user_id not in (select user_id from public.marketer_account_ids);
create or replace view public.v_demo_transactions as
  select t.* from public.transactions t
   where t.user_id in (select user_id from public.marketer_account_ids);

create or replace view public.v_real_wallets as
  select w.* from public.wallets w
   where w.user_id not in (select user_id from public.marketer_account_ids);
create or replace view public.v_demo_wallets as
  select w.* from public.wallets w
   where w.user_id in (select user_id from public.marketer_account_ids);

-- ── Isolation audit: real vs demo counts + a LEAKAGE probe (must always be 0) ─────────────────────
-- leaked = rows visible in a v_real_* view that are actually in the demo cohort. 0 by construction;
-- a non-zero value means a view was mis-edited. Use in monitoring/tests as the isolation invariant.
create or replace function public.fn_demo_isolation_report()
returns table(table_name text, real_rows bigint, demo_rows bigint, leaked bigint)
language sql stable security definer set search_path = public as $fn$
  with mk as (select user_id from public.marketer_account_ids)
  select 'positions',    (select count(*) from public.v_real_positions),
                         (select count(*) from public.v_demo_positions),
                         (select count(*) from public.v_real_positions r where r.user_id in (select user_id from mk))
  union all
  select 'ledger_entries',(select count(*) from public.v_real_ledger_entries),
                          (select count(*) from public.v_demo_ledger_entries),
                          (select count(*) from public.v_real_ledger_entries r where r.user_id in (select user_id from mk))
  union all
  select 'transactions', (select count(*) from public.v_real_transactions),
                         (select count(*) from public.v_demo_transactions),
                         (select count(*) from public.v_real_transactions r where r.user_id in (select user_id from mk))
  union all
  select 'wallets',      (select count(*) from public.v_real_wallets),
                         (select count(*) from public.v_demo_wallets),
                         (select count(*) from public.v_real_wallets r where r.user_id in (select user_id from mk))
  union all
  select 'profiles',     (select count(*) from public.v_real_profiles),
                         (select count(*) from public.v_demo_profiles),
                         (select count(*) from public.v_real_profiles r where r.id in (select user_id from mk));
$fn$;

-- ── Rewire fn_platform_overview onto the views: ONE definition of "real" (output unchanged) ────────
create or replace function public.fn_platform_overview(p_actor_role text)
 returns table(site_id uuid, slug text, name text, status text, users bigint, deposits_cents bigint,
               withdrawals_cents bigint, ggr_cents bigint, open_positions bigint, bets bigint)
 language plpgsql security definer set search_path to 'public'
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
      left join lateral (select count(*) n from public.v_real_profiles pr
                          where pr.site_id = s.id) u on true
      left join lateral (select coalesce(sum(amount),0) amt from public.v_real_transactions t
                          where t.site_id = s.id and t.kind='deposit' and t.status='success') d on true
      left join lateral (select coalesce(sum(amount),0) amt from public.v_real_transactions t
                          where t.site_id = s.id and t.kind='withdrawal' and t.status='success'
                            and t.provider is distinct from 'internal') w on true
      left join lateral (select coalesce(sum(stake - payout) filter (where po.status='settled'),0) ggr,
                                count(*) filter (where po.status='open')    open_n,
                                count(*) filter (where po.status='settled') bet_n
                           from public.v_real_positions po
                          where po.site_id = s.id) p on true
     order by s.created_at asc;
end;
$function$;

do $g$
begin
  grant select on public.v_real_profiles, public.v_demo_profiles,
                   public.v_real_positions, public.v_demo_positions,
                   public.v_real_ledger_entries, public.v_demo_ledger_entries,
                   public.v_real_transactions, public.v_demo_transactions,
                   public.v_real_wallets, public.v_demo_wallets
                to service_role;
  revoke all on function public.fn_demo_isolation_report() from public, anon, authenticated;
  grant execute on function public.fn_demo_isolation_report() to service_role;
end $g$;
