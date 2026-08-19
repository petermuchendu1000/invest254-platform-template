-- 0078_referral_commissions.sql — deposit-based referral commissions (the proper re-introduction).
--
-- MODEL (confirmed with product):
--   On each REAL, successful M-Pesa deposit by a player, walk that player's referral attribution
--   (profiles.referred_by, set first-touch at registration) and pay commission on the DEPOSIT amount.
--
--   (a) DIRECT REFERRER IS A PLAYER  -> retail referral: 5% of the deposit, credited INSTANTLY to
--       that player's game wallet (real_balance) so it is immediately spendable/withdrawable.
--
--   (b) DIRECT REFERRER IS A MARKETER -> a DIFFERENTIAL UNILEVEL chain up the marketer recruitment
--       tree (consecutive marketers via referred_by). Tiers by position FROM THE TOP:
--          position 1 = 25%, position 2 = 20%, position 3+ = 17%.
--       The DIRECT (deepest) marketer earns their tier; every upline earns the DIFFERENCE between
--       their tier and the tier just below them. The whole chain therefore ALWAYS sums to exactly
--       25% of the deposit — bounded, sustainable, fully auditable. Worked example:
--          Steve(top) -> Jane -> Joan, player deposits under Joan:
--             Joan 17%, Jane 20-17=3%, Steve 25-20=5%   (total 25%)
--       Marketer commissions ACCRUE (status='accrued'); the marketer requests a payout once the
--       balance >= KES 500 (manual M-Pesa for now, paybill automation later).
--
--   Cross-site safe (beneficiaries must be in the deposit's brand). Idempotent per (deposit, beneficiary).
--   Native GGR affiliate program (affiliate_commissions) is untouched and independent.

create table if not exists public.deposit_commissions (
  id               bigint generated always as identity primary key,
  deposit_tx_id    uuid   not null references public.transactions(id) on delete cascade,
  site_id          uuid   not null references public.sites(id),
  referred_user    uuid   not null references public.profiles(id),   -- the depositor
  beneficiary_user uuid   not null references public.profiles(id),   -- who earns the commission
  position         int    not null,                                  -- 1 = top of chain; player = 1
  beneficiary_role text   not null,                                  -- 'player' | 'marketer'
  rate             numeric not null,                                 -- effective rate applied (differential)
  deposit_amount   bigint not null,                                  -- cents
  commission_amount bigint not null,                                 -- cents
  status           text   not null default 'accrued',                -- 'accrued' (marketer) | 'paid' (player, instant)
  created_at       timestamptz not null default now(),
  unique (deposit_tx_id, beneficiary_user)                           -- idempotent re-runs
);
create index if not exists ix_depcomm_beneficiary on public.deposit_commissions(beneficiary_user, status);
create index if not exists ix_depcomm_site         on public.deposit_commissions(site_id);
grant select on public.deposit_commissions to service_role;

-- Tier rate by position from the top of the marketer chain (1=25%, 2=20%, 3+=17%).
create or replace function public.fn_marketer_tier_rate(p_position int)
returns numeric language sql immutable as $fn$
  select case when p_position <= 1 then 0.25 when p_position = 2 then 0.20 else 0.17 end
$fn$;

create or replace function public.fn_pay_referral_commissions(p_deposit_tx uuid)
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
  v_tx       public.transactions%rowtype;
  v_site     uuid; v_amt bigint; v_depositor uuid;
  v_direct   uuid; v_direct_role text;
  v_chain    uuid[] := array[]::uuid[];
  v_cur      uuid; v_role text;
  v_n int; i int; p int;
  v_rate numeric; v_comm bigint; v_created int := 0;
begin
  select * into v_tx from public.transactions where id = p_deposit_tx;
  if not found then return 0; end if;
  -- Only REAL, successful M-Pesa deposits are commissionable (admin credits / internal are not).
  if v_tx.kind <> 'deposit' or v_tx.status <> 'success' or coalesce(v_tx.provider,'') <> 'mpesa' then
    return 0;
  end if;
  v_site := v_tx.site_id; v_amt := v_tx.amount; v_depositor := v_tx.user_id;

  select referred_by into v_direct from public.profiles where id = v_depositor;
  if v_direct is null then return 0; end if;
  select role into v_direct_role from public.profiles where id = v_direct and site_id = v_site;
  if v_direct_role is null then return 0; end if;   -- cross-site guard: referrer must be same brand

  -- ── (a) retail player referral: 5% instant to the referrer's spendable game wallet ─────────────
  if v_direct_role <> 'marketer' then
    v_comm := floor(v_amt * 0.05)::bigint;
    if v_comm > 0 then
      insert into public.deposit_commissions(deposit_tx_id, site_id, referred_user, beneficiary_user,
                                             position, beneficiary_role, rate, deposit_amount, commission_amount, status)
        values (p_deposit_tx, v_site, v_depositor, v_direct, 1, v_direct_role, 0.05, v_amt, v_comm, 'paid')
        on conflict (deposit_tx_id, beneficiary_user) do nothing;
      if found then
        update public.wallets set real_balance = real_balance + v_comm
          where user_id = v_direct and site_id = v_site;
        insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
          values (v_direct, v_site, 'affiliate_commission', v_comm, 'real', 'deposit_commissions', p_deposit_tx::text,
                  jsonb_build_object('kind', 'referral', 'rate', 0.05, 'referred_user', v_depositor, 'deposit_amount', v_amt));
        v_created := v_created + 1;
      end if;
    end if;
    return v_created;
  end if;

  -- ── (b) marketer differential unilevel chain (direct first, walking up consecutive marketers) ──
  v_cur := v_direct;
  loop
    exit when v_cur is null;
    select role into v_role from public.profiles where id = v_cur and site_id = v_site;
    exit when v_role is distinct from 'marketer';
    v_chain := v_chain || v_cur;
    select referred_by into v_cur from public.profiles where id = v_cur;
  end loop;
  v_n := coalesce(array_length(v_chain, 1), 0);
  if v_n = 0 then return 0; end if;

  -- chain[i]: i=1 is the DIRECT (deepest) marketer; position-from-top p = v_n - i + 1.
  --   direct (p = v_n)  -> full tier T(p)
  --   upline (p < v_n)  -> differential  T(p) - T(p+1)
  for i in 1..v_n loop
    p := v_n - i + 1;
    if p = v_n then
      v_rate := public.fn_marketer_tier_rate(p);
    else
      v_rate := public.fn_marketer_tier_rate(p) - public.fn_marketer_tier_rate(p + 1);
    end if;
    v_comm := floor(v_amt * v_rate)::bigint;
    if v_comm > 0 then
      insert into public.deposit_commissions(deposit_tx_id, site_id, referred_user, beneficiary_user,
                                             position, beneficiary_role, rate, deposit_amount, commission_amount, status)
        values (p_deposit_tx, v_site, v_depositor, v_chain[i], p, 'marketer', v_rate, v_amt, v_comm, 'accrued')
        on conflict (deposit_tx_id, beneficiary_user) do nothing;
      if found then v_created := v_created + 1; end if;
    end if;
  end loop;
  return v_created;
end;
$fn$;

revoke all on function public.fn_pay_referral_commissions(uuid) from public, anon, authenticated;
grant execute on function public.fn_pay_referral_commissions(uuid) to service_role;

-- Re-hook the commission engine into deposit completion (idempotent; the deposit-confirmed notify
-- remains a separate trigger from 0071 and is untouched).
create or replace function public.fn_complete_deposit(
  p_checkout text, p_result_code int, p_result_desc text, p_receipt text, p_raw jsonb
) returns table(applied boolean, status text, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_tx public.transactions%rowtype; v_bal bigint;
begin
  select * into v_tx from transactions where checkout_request_id = p_checkout and kind = 'deposit' for update;
  if not found then raise exception 'TX_NOT_FOUND'; end if;
  if v_tx.status in ('success','failed') then
    select real_balance into v_bal from wallets where user_id = v_tx.user_id;
    return query select false, v_tx.status, v_bal; return;
  end if;
  if p_result_code = 0 then
    update transactions set status='success', result_code=p_result_code, result_desc=p_result_desc,
           mpesa_receipt=p_receipt, raw_callback=p_raw where id = v_tx.id;
    update wallets set real_balance = real_balance + v_tx.amount where user_id = v_tx.user_id
      returning real_balance into v_bal;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (v_tx.user_id, v_tx.site_id, 'deposit', v_tx.amount, 'real', 'transactions', v_tx.id::text,
              jsonb_build_object('receipt', p_receipt));
    -- deposit-based referral commissions (differential unilevel; idempotent)
    perform public.fn_pay_referral_commissions(v_tx.id);
    return query select true, 'success', v_bal; return;
  else
    update transactions set status='failed', result_code=p_result_code, result_desc=p_result_desc,
           raw_callback=p_raw where id = v_tx.id;
    select real_balance into v_bal from wallets where user_id = v_tx.user_id;
    return query select true, 'failed', v_bal; return;
  end if;
end;
$fn$;
