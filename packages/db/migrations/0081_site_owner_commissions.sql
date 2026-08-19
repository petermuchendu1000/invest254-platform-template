-- 0081_site_owner_commissions.sql — hybrid attribution: referral code overrides, else site owner.
--
-- Business model: each brand (site) is run by ONE assigned marketer. Every deposit on that brand is
-- credited to that marketer by default — no per-player referral code required. Referral codes remain
-- an optional OVERRIDE: if the depositing player has an explicit `referred_by` (signed up with a
-- specific code), that per-player chain is honoured instead. Precedence per deposit:
--   1) player.referred_by present  -> per-player referral chain (25/20/17 differential, or 5% player)
--   2) else                        -> sites.owner_user_id (the brand's marketer) + differential up
--                                     that owner's own recruitment chain.
-- Self-commission is blocked (a marketer's own deposit never pays themselves).

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
  if v_tx.kind <> 'deposit' or v_tx.status <> 'success' or coalesce(v_tx.provider,'') <> 'mpesa' then
    return 0;
  end if;
  v_site := v_tx.site_id; v_amt := v_tx.amount; v_depositor := v_tx.user_id;

  -- (1) referral code takes precedence; (2) else fall back to the brand's assigned marketer.
  select referred_by into v_direct from public.profiles where id = v_depositor;
  if v_direct is null then
    select owner_user_id into v_direct from public.sites where id = v_site;
  end if;
  if v_direct is null then return 0; end if;         -- no code and no site owner -> no commission
  if v_direct = v_depositor then return 0; end if;   -- never pay a marketer their own deposit
  select role into v_direct_role from public.profiles where id = v_direct and site_id = v_site;
  if v_direct_role is null then return 0; end if;    -- cross-site guard: beneficiary must be same brand

  -- (a) retail player referral: 5% instant to the referrer's spendable game wallet
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

  -- (b) marketer differential unilevel chain (direct first, walking up consecutive marketers)
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

-- Auto-assign each single-marketer brand's marketer as its owner (idempotent; only where unambiguous).
update public.sites s set owner_user_id = m.id
  from public.profiles m
 where m.role = 'marketer' and m.site_id = s.id
   and s.owner_user_id is null
   and (select count(*) from public.profiles m2 where m2.role = 'marketer' and m2.site_id = s.id) = 1;
