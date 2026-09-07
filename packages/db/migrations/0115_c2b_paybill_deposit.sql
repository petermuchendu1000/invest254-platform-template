-- 0115_c2b_paybill_deposit.sql — Manual "Lipa na M-PESA · Pay Bill" deposit with auto-verification.
--
-- WHY: alongside the STK-push deposit path, players may pay a configured Pay Bill directly from the
-- M-PESA menu and then submit the confirmation code in-app. Safaricom C2B pushes every payment made
-- to the paybill to our Confirmation URL; we store it in `c2b_payments`. A player then CLAIMS a code:
-- we credit the EXACT amount Safaricom recorded (never the client-entered amount), exactly once. This
-- is fraud-safe by construction — a code that Safaricom never confirmed cannot be claimed, a code can
-- be claimed at most once, and the amount is authoritative from the C2B record, not the client.
--
-- Money correctness mirrors fn_complete_deposit (0014/0048): credit wallets.real_balance + write a
-- ledger_entries row, both scoped to the paying user's (user_id, site_id). SECURITY DEFINER,
-- service-role only. Idempotent: safe to re-apply.

-- ── 1. paybill_config: the singleton, admin-managed display + routing config ──────────────────────
create table if not exists public.paybill_config (
  id             int primary key default 1 check (id = 1),
  enabled        boolean not null default true,
  shortcode      text not null default '',
  account_number text not null default '',
  business_name  text not null default '',
  instructions   text not null default '',
  updated_by     uuid references public.profiles(id),
  updated_at     timestamptz not null default now()
);

insert into public.paybill_config (id, enabled, shortcode, account_number, business_name)
  values (1, true, '625625', '7719580265', 'BETWOIN LTD')
  on conflict (id) do nothing;

drop trigger if exists trg_paybill_config_updated on public.paybill_config;
create trigger trg_paybill_config_updated before update on public.paybill_config
  for each row execute function public.set_updated_at();

alter table public.paybill_config enable row level security;

-- ── 2. c2b_payments: every payment Safaricom pushes to our paybill (the verification ledger) ───────
create table if not exists public.c2b_payments (
  id            uuid primary key default gen_random_uuid(),
  trans_id      text not null unique,               -- M-PESA confirmation code, UPPERCASE
  amount        bigint not null check (amount > 0),  -- integer cents (KES)
  msisdn        text,                                -- payer phone (may be masked by Safaricom)
  bill_ref      text,                                -- BillRefNumber (account number entered)
  org_shortcode text,                                -- BusinessShortCode the payment hit
  raw           jsonb,
  received_at   timestamptz not null default now(),
  claimed_tx_id uuid references public.transactions(id),
  claimed_by    uuid references public.profiles(id),
  claimed_at    timestamptz
);
create index if not exists idx_c2b_msisdn on public.c2b_payments(msisdn);
create index if not exists idx_c2b_unclaimed on public.c2b_payments(claimed_tx_id) where claimed_tx_id is null;

alter table public.c2b_payments enable row level security;

-- ── 3. fn_ingest_c2b: idempotent store of a C2B confirmation (service-role; called by the API) ─────
-- Returns true when a NEW row was stored, false when the code was already recorded (Safaricom retries
-- the confirmation until it gets a 200, so this must be safe to call repeatedly).
create or replace function public.fn_ingest_c2b(
  p_trans_id text, p_amount bigint, p_msisdn text, p_bill_ref text, p_shortcode text, p_raw jsonb
) returns boolean language plpgsql security definer set search_path = public
as $fn$
declare v_code text := upper(btrim(coalesce(p_trans_id, '')));
begin
  if v_code = '' or p_amount is null or p_amount <= 0 then raise exception 'INVALID_C2B'; end if;
  insert into public.c2b_payments(trans_id, amount, msisdn, bill_ref, org_shortcode, raw)
    values (v_code, p_amount, p_msisdn, p_bill_ref, p_shortcode, p_raw)
    on conflict (trans_id) do nothing;
  return found;  -- true = inserted, false = duplicate (idempotent no-op)
end;
$fn$;

-- ── 4. fn_claim_c2b_deposit: a player claims a confirmation code → credit the verified amount ──────
-- Statuses: 'credited' (first successful claim), 'already_claimed' (same user re-submits — idempotent,
-- no double credit), 'not_found' (no such code recorded yet). A code claimed by a DIFFERENT user
-- raises CODE_ALREADY_USED. The credited amount is ALWAYS the Safaricom-recorded amount.
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

  return query select 'credited'::text, v_pay.amount, v_bal, v_tx; return;
end;
$fn$;

-- ── 5. Lock down grants: service_role only (the engine); nothing to anon/authenticated ─────────────
do $grants$
begin
  revoke all on function public.fn_ingest_c2b(text,bigint,text,text,text,jsonb)  from public;
  revoke all on function public.fn_claim_c2b_deposit(uuid,text,uuid)             from public;
  grant execute on function public.fn_ingest_c2b(text,bigint,text,text,text,jsonb)  to service_role;
  grant execute on function public.fn_claim_c2b_deposit(uuid,text,uuid)             to service_role;
end
$grants$;
