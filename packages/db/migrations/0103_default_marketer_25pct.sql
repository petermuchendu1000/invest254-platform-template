-- 0103_default_marketer_25pct.sql — every deposit pays 25% to the brand's DEFAULT marketer,
-- distributed hierarchically up the site's marketer tree.
--
-- Business model (authoritative): each brand (site) is run by ONE assigned DEFAULT marketer
-- (`sites.owner_user_id`). EVERY successful M-Pesa deposit on that brand pays a total of 25%
-- commission into the brand's marketer hierarchy, ALWAYS rooted at the default marketer:
--   * Unreferred deposit                    -> the default marketer earns the full 25%.
--   * Player referred by a sub-marketer     -> the 25% is split differentially up the chain
--                                              (recruiter earns the bulk, each upline an override),
--                                              and the default marketer at the ROOT always earns
--                                              their override. Totals always sum to exactly 25%.
-- Differential tiers come from fn_marketer_tier_rate (pos1 25% / pos2 20% / pos3+ 17%), so:
--   1 level  -> 25%
--   2 levels -> 20% (recruiter) + 5% (upline)          = 25%
--   3 levels -> 17% + 3% + 5%                            = 25%
-- Self-commission is blocked (a marketer's own deposit never pays themselves).
-- An OPTIONAL retail player-referral perk (5% instant, non-marketer referrer) is preserved and is
-- ADDITIVE to the marketer 25% — it never cannibalises the default marketer's cut.
--
-- Change vs 0081: the marketer chain is now ALWAYS rooted at the site's default marketer, so the
-- default marketer earns on EVERY deposit (previously a sub-marketer referral could take the whole
-- 25% and leave the default marketer with nothing). Additive, idempotent, revertible.

create or replace function public.fn_pay_referral_commissions(p_deposit_tx uuid)
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
  v_tx       public.transactions%rowtype;
  v_site     uuid; v_amt bigint; v_depositor uuid;
  v_owner    uuid;
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

  -- The brand's DEFAULT marketer (root of the site's marketer hierarchy).
  select owner_user_id into v_owner from public.sites where id = v_site;

  -- The depositing player's direct referrer (optional first-touch attribution).
  select referred_by into v_direct from public.profiles where id = v_depositor;

  -- (a) Retail PLAYER referral perk (unchanged): if the direct referrer is a NON-marketer player,
  --     pay them 5% instantly into their spendable wallet. ADDITIVE to the marketer 25% below.
  if v_direct is not null and v_direct <> v_depositor then
    select role into v_direct_role from public.profiles where id = v_direct and site_id = v_site;
    if v_direct_role is not null and v_direct_role <> 'marketer' then
      v_comm := floor(v_amt * 0.05)::bigint;
      if v_comm > 0 then
        insert into public.deposit_commissions(deposit_tx_id, site_id, referred_user, beneficiary_user,
                                               position, beneficiary_role, rate, deposit_amount, commission_amount, status)
          values (p_deposit_tx, v_site, v_depositor, v_direct, 0, v_direct_role, 0.05, v_amt, v_comm, 'paid')
          on conflict (deposit_tx_id, beneficiary_user) do nothing;
        if found then
          update public.wallets set real_balance = real_balance + v_comm
            where user_id = v_direct and site_id = v_site;
          insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
            values (v_direct, v_site, 'affiliate_commission', v_comm, 'real', 'deposit_commissions', p_deposit_tx::text,
                    jsonb_build_object('kind','player_referral','rate',0.05,'referred_user',v_depositor,'deposit_amount',v_amt));
          v_created := v_created + 1;
        end if;
      end if;
    end if;
  end if;

  -- (b) MARKETER hierarchy — 25% of the deposit, distributed differentially up the site's marketer
  --     tree, ALWAYS rooted at the brand's default marketer. Build the chain from the direct
  --     referrer IF a same-site marketer, walking up consecutive same-site marketers; then guarantee
  --     the default marketer is the ROOT (append if not already the top). Never include the depositor.
  v_cur := v_direct;
  loop
    exit when v_cur is null;
    exit when v_cur = v_depositor;                 -- never pay the depositor
    select role into v_role from public.profiles where id = v_cur and site_id = v_site;
    exit when v_role is distinct from 'marketer';
    v_chain := v_chain || v_cur;
    select referred_by into v_cur from public.profiles where id = v_cur;
  end loop;

  -- Guarantee the site's default marketer is the ROOT (top) of the chain.
  if v_owner is not null and v_owner <> v_depositor then
    if array_length(v_chain, 1) is null or v_chain[array_length(v_chain, 1)] <> v_owner then
      if exists (select 1 from public.profiles
                  where id = v_owner and site_id = v_site and role = 'marketer') then
        v_chain := v_chain || v_owner;
      end if;
    end if;
  end if;

  v_n := coalesce(array_length(v_chain, 1), 0);
  if v_n = 0 then return v_created; end if;

  -- Differential unilevel: chain[1] = direct recruiter (bottom), chain[n] = default marketer (top).
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

-- Generic, idempotent: assign the SOLE marketer of any single-marketer brand as its default marketer
-- (only where unambiguous and not already set). Multi-marketer brands are assigned by operations.
update public.sites s set owner_user_id = m.id
  from public.profiles m
 where m.role = 'marketer' and m.site_id = s.id
   and s.owner_user_id is null
   and (select count(*) from public.profiles m2 where m2.role = 'marketer' and m2.site_id = s.id) = 1;
