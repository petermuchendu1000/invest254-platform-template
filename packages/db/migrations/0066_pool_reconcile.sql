-- 0066_pool_reconcile.sql — Phase 5 of the pool-brain (docs/25): a read-only reconciliation function
-- that proves the daily withdrawal pool's invariants for a given EAT day. It never mutates; it just
-- surfaces any drift so the nightly job (scripts/pool_reconcile.py) can alert. Three invariants:
--   1. HARD CAP        : amount_cents - paid_cents - reserved_cents >= 0   (the 0062 CHECK; must hold).
--   2. LEDGER TIE      : withdrawal_pool.reserved_cents = Σreserve − Σcommit − Σrelease  (from pool_ledger)
--                        AND withdrawal_pool.paid_cents = Σcommit.
--   3. PAYOUT TIE      : paid_cents (pool-committed wins) must not exceed the settled winning payouts
--                        credited to players for that brand/day — i.e. the pool never "paid" more than
--                        the game actually credited. Reports the delta (payouts − paid) for visibility.
-- SECURITY DEFINER, service-role only, STABLE. Additive + idempotent (CREATE OR REPLACE).

create or replace function public.fn_pool_reconcile(p_day date default current_date)
returns table (
  site_id uuid, slug text, trade_day date,
  amount_cents bigint, paid_cents bigint, reserved_cents bigint, available_cents bigint,
  ledger_reserved bigint, ledger_paid bigint,
  settled_payout_cents bigint,
  hardcap_ok boolean, reserved_tie_ok boolean, paid_tie_ok boolean, payout_tie_ok boolean,
  note text
)
language sql stable security definer set search_path = public as $$
  with wp as (
    select w.site_id, w.trade_day, w.amount_cents, w.paid_cents, w.reserved_cents
      from public.withdrawal_pool w
     where w.trade_day = p_day
  ),
  led as (
    select l.site_id, l.trade_day,
           coalesce(sum(l.amount_cents) filter (where l.kind = 'reserve'), 0)
             - coalesce(sum(l.amount_cents) filter (where l.kind = 'commit'), 0)
             - coalesce(sum(l.amount_cents) filter (where l.kind = 'release'), 0) as ledger_reserved,
           coalesce(sum(l.amount_cents) filter (where l.kind = 'commit'), 0) as ledger_paid
      from public.pool_ledger l
     where l.trade_day = p_day
     group by l.site_id, l.trade_day
  ),
  pay as (
    -- winning payouts the game actually credited for this brand/day (by trade date, matching reportDaily)
    select s.id as site_id,
           coalesce(sum(greatest(po.payout - po.stake, 0)), 0)::bigint as settled_payout_cents
      from public.positions po
      join public.profiles pr on pr.id = po.user_id
      join public.sites s on s.id = pr.site_id
      left join public.game_days gd on gd.id = po.game_day_id
     where po.status = 'settled'
       and coalesce(gd.trade_date, po.settled_at::date, po.opened_at::date) = p_day
     group by s.id
  )
  select
    wp.site_id, si.slug, wp.trade_day,
    wp.amount_cents, wp.paid_cents, wp.reserved_cents,
    (wp.amount_cents - wp.paid_cents - wp.reserved_cents) as available_cents,
    coalesce(led.ledger_reserved, 0) as ledger_reserved,
    coalesce(led.ledger_paid, 0) as ledger_paid,
    coalesce(pay.settled_payout_cents, 0) as settled_payout_cents,
    (wp.amount_cents - wp.paid_cents - wp.reserved_cents) >= 0 as hardcap_ok,
    (wp.reserved_cents = coalesce(led.ledger_reserved, 0)) as reserved_tie_ok,
    (wp.paid_cents = coalesce(led.ledger_paid, 0)) as paid_tie_ok,
    -- pool must never have committed more than the game credited (tiny under is fine: unpaced budget)
    (wp.paid_cents <= coalesce(pay.settled_payout_cents, 0)) as payout_tie_ok,
    case
      when (wp.amount_cents - wp.paid_cents - wp.reserved_cents) < 0 then 'HARDCAP BREACH'
      when wp.reserved_cents <> coalesce(led.ledger_reserved, 0) then 'RESERVED DRIFT'
      when wp.paid_cents <> coalesce(led.ledger_paid, 0) then 'PAID DRIFT'
      when wp.paid_cents > coalesce(pay.settled_payout_cents, 0) then 'PAID > PAYOUTS'
      else 'ok'
    end as note
  from wp
  join public.sites si on si.id = wp.site_id
  left join led on led.site_id = wp.site_id and led.trade_day = wp.trade_day
  left join pay on pay.site_id = wp.site_id
  order by si.slug
$$;

revoke all on function public.fn_pool_reconcile(date) from public, anon, authenticated;
