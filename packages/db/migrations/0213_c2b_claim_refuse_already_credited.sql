-- 0213_c2b_claim_refuse_already_credited.sql — a C2B payment that already credited a deposit can
-- no longer be claimed a second time (BUGLOG #163).
--
-- THE HOLE. `fn_claim_c2b_deposit` guarded only against claiming the SAME c2b_payments row twice
-- (`claimed_tx_id is not null`). It never asked whether the money that row represents had already
-- been credited through the deposit it belongs to, and it never compared the claimant to the payer.
--
-- That is exploitable today because of a separate defect (fixed separately): PayHero echoes our
-- `transactions.id` as the ledger row's `external_reference`, but `ownedDepositRefs` and
-- `fn_complete_deposit` both resolve a payment by `transactions.checkout_request_id`. So the ledger
-- sweep's auto-credit branch never matches for PayHero, and EVERY PayHero payment is additionally
-- ingested into `c2b_payments` as claimable — a shadow of a deposit that the provider callback has
-- already credited. Measured in production: of 455 unclaimed PayHero rows, 452 carry a `bill_ref`
-- equal to a real `transactions.id` and 0 match any `checkout_request_id`; for all 452 the row's
-- `trans_id` is the very `mpesa_receipt` stored on the player's own successful deposit — a code the
-- player reads off their M-Pesa SMS and their in-app history. 451 of those sit on brands whose live
-- payment scope is 'global' and which have PayHero enabled, i.e. where the claim route does not
-- refuse. KES 152,306 was double-claimable. Nobody had claimed one yet (claimed = 0).
--
-- THE INVARIANT this restores, stated plainly:
--   A C2B payment may be credited AT MOST ONCE, by exactly one of
--     (i)  the deposit it was initiated for  -> fn_complete_deposit, or
--     (ii) a manual claim                    -> fn_claim_c2b_deposit
--   never both.
--
-- WHY THE GUARD IS THIS SHAPE.
--   * `bill_ref` identifying one of our deposits is the exact signature of a payment that belongs to
--     a deposit. It is compared as `id::text = bill_ref` — never `bill_ref::uuid`, which would throw
--     on the ordinary Pay Bill case where `bill_ref` is a human-typed account reference.
--   * It refuses for ANY status of that deposit, not just 'success'. A payment whose deposit is still
--     'processing' must settle as that deposit; letting it be claimed now would simply move the
--     double credit later, once the ledger matcher is fixed.
--   * The receipt check is defence in depth, for a payment whose `bill_ref` is absent or unrelated
--     but whose code is already recorded against a credited deposit.
--
-- ORDERING IS LOAD-BEARING: this sits AFTER the `claimed_tx_id` check, so a row the same user has
-- already claimed still returns 'already_claimed' (idempotent for an impatient tap) instead of the
-- new refusal. It sits BEFORE any write, so a refusal does no partial work.
--
-- NOT AFFECTED: the ordinary Daraja Pay Bill claim. Those payments are ingested with `bill_ref` set
-- to whatever the payer typed as the account number, which is not a transaction id, and their code
-- is not on any deposit until this function itself puts it there.
--
-- Rollback: re-apply the body from 0117 (this file changes nothing else). Idempotent.

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

  -- ── 0213: this money already reached a wallet through its own deposit. Refuse. ────────────────
  if v_pay.bill_ref is not null and exists (
       select 1 from public.transactions t
        where t.id::text = v_pay.bill_ref and t.kind = 'deposit' and t.status <> 'failed')
  then
    raise exception 'CODE_ALREADY_CREDITED';
  end if;
  if exists (
       select 1 from public.transactions t
        where t.mpesa_receipt = v_code and t.kind = 'deposit' and t.status = 'success')
  then
    raise exception 'CODE_ALREADY_CREDITED';
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
  -- rails do via fn_complete_deposit. Idempotent (on-conflict inside the RPC).
  perform public.fn_pay_referral_commissions(v_tx);

  return query select 'credited'::text, v_pay.amount, v_bal, v_tx; return;
end;
$fn$;

revoke all on function public.fn_claim_c2b_deposit(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_c2b_deposit(uuid, text, uuid) to service_role;

-- The guard's first branch is an id lookup (primary key); the second needs this to stay cheap as
-- `transactions` grows. Partial: only successful deposits carry a receipt worth matching.
create index if not exists transactions_mpesa_receipt_deposit_idx
  on public.transactions (mpesa_receipt)
  where kind = 'deposit' and status = 'success' and mpesa_receipt is not null;
