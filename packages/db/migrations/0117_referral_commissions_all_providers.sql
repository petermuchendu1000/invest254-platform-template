-- 0117_referral_commissions_all_providers.sql — accrue referral/marketer commissions on EVERY
-- real-cash deposit rail (bug fix).
--
-- WHY: fn_pay_referral_commissions (0103) early-returned unless transactions.provider = 'mpesa'.
-- That predates the Mega Pay gateway (0116, provider='megapay') and the Pay Bill / C2B rail
-- (0115, provider='mpesa_paybill'). Result in production: every Mega Pay deposit (the only rail in
-- use since the switch) created ZERO deposit_commissions rows, so marketers saw no commissions and
-- no recent referred deposits on their dashboard. C2B paybill had a second, independent bug: its
-- claim RPC credited the wallet but never called fn_pay_referral_commissions at all.
--
-- FIX (idempotent, revertible, no data migration):
--   1. fn_pay_referral_commissions — drop the provider hard-code; accrue for any successful deposit
--      (kind='deposit' AND status='success'). This RPC is only ever called from real-cash deposit
--      completion, and only real-cash inflows use that (kind,status), so it stays correct and is now
--      rail-agnostic (future gateways work with no further change).
--   2. fn_claim_c2b_deposit — call fn_pay_referral_commissions after crediting, so Pay Bill deposits
--      accrue exactly like the STK + Mega Pay rails.
--
-- Bodies are copied verbatim from 0103 / 0115 with ONLY the changes described above. CREATE OR
-- REPLACE preserves existing privileges; grants are re-issued for parity with the source migrations.

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
  -- Accrue for EVERY successful real-cash deposit, regardless of gateway. The old guard
  -- hard-coded provider='mpesa' (written before the Mega Pay + Pay Bill rails existed),
  -- which silently skipped commissions for provider='megapay'/'mpesa_paybill'. This RPC is
  -- only ever invoked from real-cash deposit completion (fn_complete_deposit + the C2B
  -- claim), and only real-cash inflows use kind='deposit'/status='success', so keying on
  -- those two columns is correct and rail-agnostic (any future gateway works automatically).
  if v_tx.kind <> 'deposit' or v_tx.status <> 'success' then
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

create or replace function public.fn_claim_c2b_deposit(p_user uuid, p_code text, p_site_id uuid)
returns table(status text, amount bigint, new_balance bigint, tx_id uuid)
language plpgsql security definer set search_path = public
as $fn$
declare v_code text := upper(btrim(coalesce(p_code, '')));
        v_pay public.c2b_payments%rowtype;
        v_bal bigint;
        v_tx  uuid;
begin
  if v_code = '' then raise exception 'INVALID_CODE'; end if;

  -- Lock the payment row so two concurrent claims of the same code serialise (no double credit).
  select * into v_pay from public.c2b_payments where trans_id = v_code for update;
  if not found then
    return query select 'not_found'::text, null::bigint, null::bigint, null::uuid; return;
  end if;

  if v_pay.claimed_tx_id is not null then
    select real_balance into v_bal from public.wallets where user_id = p_user and site_id = p_site_id;
    if v_pay.claimed_by = p_user then
      return query select 'already_claimed'::text, v_pay.amount, v_bal, v_pay.claimed_tx_id; return;
    end if;
    raise exception 'CODE_ALREADY_USED';
  end if;

  if not exists (select 1 from public.wallets where user_id = p_user and site_id = p_site_id) then
    raise exception 'WALLET_NOT_FOUND';
  end if;

  insert into public.transactions(user_id, site_id, kind, amount, status, provider, phone, mpesa_receipt, result_code, result_desc)
    values (p_user, p_site_id, 'deposit', v_pay.amount, 'success', 'mpesa_paybill', v_pay.msisdn, v_code, 0, 'c2b:paybill')
    returning id into v_tx;

  update public.wallets set real_balance = real_balance + v_pay.amount
    where user_id = p_user and site_id = p_site_id
    returning real_balance into v_bal;

  insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, p_site_id, 'deposit', v_pay.amount, 'real', 'transactions', v_tx::text,
            jsonb_build_object('receipt', v_code, 'source', 'paybill_c2b'));

  update public.c2b_payments set claimed_tx_id = v_tx, claimed_by = p_user, claimed_at = now()
    where id = v_pay.id;

  -- Deposit-based referral commissions (0078/0081/0103): a Pay Bill (C2B) claim is a real cash
  -- deposit, so it must accrue marketer/player commissions exactly like the STK + Mega Pay
  -- rails do via fn_complete_deposit. Previously this was missing entirely, so paybill
  -- deposits paid no commission. Idempotent (on-conflict inside the RPC).
  perform public.fn_pay_referral_commissions(v_tx);

  return query select 'credited'::text, v_pay.amount, v_bal, v_tx; return;
end;
$fn$;

-- Grants (parity with source migrations; CREATE OR REPLACE already preserves ACLs).
revoke all on function public.fn_pay_referral_commissions(uuid) from public, anon, authenticated;
grant execute on function public.fn_pay_referral_commissions(uuid) to service_role;
revoke all on function public.fn_claim_c2b_deposit(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_c2b_deposit(uuid, text, uuid) to service_role;
