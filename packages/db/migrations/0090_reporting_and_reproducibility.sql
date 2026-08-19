-- 0090_reporting_and_reproducibility.sql — three audit/reporting primitives (docs/28 §4 / rec #6/#7):
--   1. fn_real_cash_rtp        — REAL-CASH RTP from committed ledger money (balance_kind='real'),
--      with the marketer/demo cohort (balance_kind='demo') shown SEPARATELY, plus real M-Pesa
--      deposits/withdrawals. Distinct from the virtual-curve RTP monitor (which reads `positions`).
--   2. fn_config_change_review — economy-change history with per-version diffs + risk flags (the
--      "change review" half of clamping config thrash; the rate-limit lives in 0085).
--   3. reproducibility_check_runs — durable audit log for the nightly provable-fairness guard
--      (recompute recent positions from seed+config_version+entryT+nonce, assert == recorded).
-- All read-only / additive. SECURITY DEFINER, service-role only. Idempotent.

-- ── 1. Real-cash RTP (committed money truth) ────────────────────────────────────────────────────────
create or replace function public.fn_real_cash_rtp(p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare result jsonb := '[]'::jsonb; w record;
        r_turn bigint; r_pay bigint; r_n bigint; d_turn bigint; d_pay bigint; d_n bigint;
        dep bigint; wd bigint; site_edge numeric;
begin
  select house_edge into site_edge from site_game_config
    where site_id = coalesce(p_site, '00000000-0000-0000-0000-000000000001');
  for w in select * from (values ('7d', interval '7 days'), ('30d', interval '30 days'), ('all', null::interval)) t(win, span) loop
    -- Partition by the MARKETER COHORT (marketer_account_ids), NOT balance_kind: marketer ledger rows
    -- are balance_kind='demo' only AFTER migration 0084; historical marketer rows are 'real'. Cohort
    -- partition is stable across that boundary. REAL = real players' committed cash ('real' kind,
    -- excludes bonus + marketers); MARKETER/DEMO = the whole marketer cohort's (funny-money) flow.
    select coalesce(sum(-amount) filter (where type='stake'  and balance_kind='real' and user_id not in (select user_id from marketer_account_ids)),0),
           coalesce(sum( amount) filter (where type='payout' and balance_kind='real' and user_id not in (select user_id from marketer_account_ids)),0),
           count(*)              filter (where type='stake'  and balance_kind='real' and user_id not in (select user_id from marketer_account_ids)),
           coalesce(sum(-amount) filter (where type='stake'  and user_id in (select user_id from marketer_account_ids)),0),
           coalesce(sum( amount) filter (where type='payout' and user_id in (select user_id from marketer_account_ids)),0),
           count(*)              filter (where type='stake'  and user_id in (select user_id from marketer_account_ids))
      into r_turn, r_pay, r_n, d_turn, d_pay, d_n
      from ledger_entries
     where (p_site is null or site_id = p_site)
       and (w.span is null or created_at >= now() - w.span);
    -- Committed CASH movement: real M-Pesa deposits in, real withdrawals out (exclude internal marketer transfers).
    select coalesce(sum(amount) filter (where kind='deposit'    and status='success'),0),
           coalesce(sum(amount) filter (where kind='withdrawal' and status='success' and provider is distinct from 'internal'),0)
      into dep, wd
      from transactions
     where (p_site is null or site_id = p_site)
       and (w.span is null or created_at >= now() - w.span);
    result := result || jsonb_build_object(
      'window', w.win,
      'real', jsonb_build_object('turnoverCents', r_turn, 'payoutCents', r_pay, 'ggrCents', r_turn - r_pay,
                                 'bets', r_n, 'rtp', case when r_turn > 0 then round(r_pay::numeric / r_turn, 4) else null end),
      'demo', jsonb_build_object('turnoverCents', d_turn, 'payoutCents', d_pay, 'ggrCents', d_turn - d_pay,
                                 'bets', d_n, 'rtp', case when d_turn > 0 then round(d_pay::numeric / d_turn, 4) else null end),
      'cash', jsonb_build_object('depositsCents', dep, 'withdrawalsCents', wd, 'netCashCents', dep - wd));
  end loop;
  return jsonb_build_object('rtpTarget', case when site_edge is not null then round(1 - site_edge, 4) else null end, 'windows', result);
end $fn$;

-- ── 2. Config-change review (history + diff + risk) ─────────────────────────────────────────────────
create or replace function public.fn_config_change_review(p_site uuid, p_limit int default 50)
returns table(version bigint, created_at timestamptz, house_edge numeric, target_win_rate numeric,
              max_multiplier numeric, prev_house_edge numeric, prev_target_win_rate numeric,
              changed_fields text[], risk boolean, risk_reason text)
language sql stable security definer set search_path = public as $fn$
  with v as (
    select sgv.*,
           lag(house_edge)      over w as prev_he,
           lag(target_win_rate) over w as prev_wr,
           lag(max_multiplier)  over w as prev_mm,
           lag(drift_bias)      over w as prev_db,
           lag(volatility)      over w as prev_vol,
           lag(min_withdrawal)  over w as prev_minw
      from public.site_game_config_versions sgv
     where sgv.site_id = p_site
    window w as (order by version)
  )
  select v.version, v.created_at, v.house_edge, v.target_win_rate, v.max_multiplier, v.prev_he, v.prev_wr,
    array_remove(array[
      case when v.prev_he  is distinct from v.house_edge      then 'house_edge'      end,
      case when v.prev_wr  is distinct from v.target_win_rate then 'target_win_rate' end,
      case when v.prev_mm  is distinct from v.max_multiplier  then 'max_multiplier'  end,
      case when v.prev_db  is distinct from v.drift_bias      then 'drift_bias'      end,
      case when v.prev_vol is distinct from v.volatility      then 'volatility'      end,
      case when v.prev_minw is distinct from v.min_withdrawal then 'min_withdrawal'  end
    ], null) as changed_fields,
    (coalesce(v.prev_he - v.house_edge, 0) >= 0.15
       or abs(coalesce(v.target_win_rate - v.prev_wr, 0)) >= 0.25
       or v.house_edge <= 0.03) as risk,
    (case when coalesce(v.prev_he - v.house_edge, 0) >= 0.15
            then 'house_edge dropped ' || round(v.prev_he - v.house_edge, 3)::text || ' (more player-favorable); ' else '' end ||
     case when abs(coalesce(v.target_win_rate - v.prev_wr, 0)) >= 0.25
            then 'target_win_rate swing ' || round(abs(v.target_win_rate - v.prev_wr), 3)::text || '; ' else '' end ||
     case when v.house_edge <= 0.03 then 'thin house_edge ' || v.house_edge::text || '; ' else '' end) as risk_reason
  from v order by v.version desc limit p_limit
$fn$;

-- ── 3. Reproducibility-check audit log (nightly provable-fairness guard) ────────────────────────────
create table if not exists public.reproducibility_check_runs (
  id            bigserial primary key,
  ran_at        timestamptz not null default now(),
  site_id       uuid,
  window_desc   text,
  sampled       int  not null default 0,
  matched       int  not null default 0,
  mismatched    int  not null default 0,
  mismatch_pct  numeric,
  ok            boolean not null default true,
  details       jsonb,     -- up to N mismatching position ids + recorded vs recomputed
  notes         text
);
create index if not exists reproducibility_check_runs_ran_at_idx on public.reproducibility_check_runs(ran_at desc);

do $g$
begin
  revoke all on function public.fn_real_cash_rtp(uuid)                from public, anon, authenticated;
  grant  execute on function public.fn_real_cash_rtp(uuid)            to service_role;
  revoke all on function public.fn_config_change_review(uuid,int)     from public, anon, authenticated;
  grant  execute on function public.fn_config_change_review(uuid,int) to service_role;
  grant  select, insert on public.reproducibility_check_runs          to service_role;
  grant  usage on sequence public.reproducibility_check_runs_id_seq   to service_role;
end $g$;
