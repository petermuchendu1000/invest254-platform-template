-- 0068_referral_commissions.sql — instant, multi-level referral commissions on real deposits.
--
-- MODEL (locked with product):
--   * Every user (player OR marketer) has a referral code + link (profiles.referral_code).
--   * When a REFERRED player makes a REAL M-Pesa deposit of amount D (kind='deposit',
--     provider='mpesa', status->'success'), commission is paid INSTANTLY up the referrer chain,
--     credited to each beneficiary's REAL wallet balance:
--       - Level 1 (direct referrer):  marketer -> 25% of D   |  plain player -> 5% of D
--       - Level 2 (referrer's referrer):   marketer -> 20% of D
--       - Level 3 (their referrer):        marketer -> 17% of D
--     (players earn only at level 1; levels 2-3 are marketer-only overrides.)
--   * ADMIN CREDITS ARE EXCLUDED: an admin "internal deposit" is a ledger_entries('adjustment'),
--     never a transactions('deposit') row, so it can never trigger commission. (Enforced by the
--     kind='deposit' AND provider='mpesa' gate below.)
--   * Idempotent per (deposit, level): the STK callback + the reconcile sweep both call the same
--     completion RPC, and re-runs never double-pay.
--
-- Additive + idempotent (safe to re-run).

-- ── 1. Per-user referral code (everyone can refer) ──────────────────────────────────────────────
alter table public.profiles add column if not exists referral_code text;

-- Crockford-ish alphabet (no 0/O/1/I/L) — matches the affiliate code style. Globally unique.
create or replace function public.fn_gen_referral_code() returns text
language plpgsql as $g$
declare alphabet text := '23456789ABCDEFGHJKMNPQRSTVWXYZ'; code text; i int;
begin
  loop
    code := '';
    for i in 1..7 loop code := code || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.profiles where referral_code = code);
  end loop;
  return code;
end $g$;

do $bf$
declare r record;
begin
  -- Reuse each affiliate's existing code so their live links keep working.
  update public.profiles p set referral_code = a.referral_code
    from public.affiliates a where a.user_id = p.id and p.referral_code is null;
  -- Mint a fresh code for everyone else.
  for r in select id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = public.fn_gen_referral_code() where id = r.id;
  end loop;
end $bf$;

create unique index if not exists uq_profiles_referral_code on public.profiles(referral_code);

-- ── 2. Commission ledger (one row per deposit+level; idempotency anchor) ────────────────────────
create table if not exists public.deposit_commissions (
  id                bigint generated always as identity primary key,
  deposit_tx_id     uuid   not null references public.transactions(id),
  site_id           uuid   not null references public.sites(id),
  referred_user     uuid   not null references public.profiles(id),  -- the depositor
  beneficiary_user  uuid   not null references public.profiles(id),  -- who earns
  level             int    not null check (level between 1 and 3),
  beneficiary_role  text   not null,
  rate              numeric not null,
  deposit_amount    bigint not null,
  commission_amount bigint not null,
  created_at        timestamptz not null default now(),
  unique (deposit_tx_id, level)
);
create index if not exists ix_depcomm_beneficiary on public.deposit_commissions(beneficiary_user, created_at desc);
create index if not exists ix_depcomm_site        on public.deposit_commissions(site_id, created_at desc);
create index if not exists ix_depcomm_referred    on public.deposit_commissions(referred_user);

-- ── 3. The instant multi-level payout RPC ───────────────────────────────────────────────────────
create or replace function public.fn_pay_referral_commissions(p_deposit_tx uuid)
returns integer               -- number of commission rows created this call
language plpgsql security definer set search_path = public
as $fn$
declare
  v_tx   public.transactions%rowtype;
  v_site uuid; v_amt bigint;
  v_cur  uuid; v_ben uuid; v_role text; v_rate numeric; v_comm bigint;
  v_level int; v_created int := 0;
begin
  select * into v_tx from public.transactions where id = p_deposit_tx;
  if not found then return 0; end if;
  -- Only REAL, successful M-Pesa deposits are commissionable (admin credits are not tx rows).
  if v_tx.kind <> 'deposit' or v_tx.status <> 'success' or coalesce(v_tx.provider,'') <> 'mpesa' then
    return 0;
  end if;
  v_site := v_tx.site_id; v_amt := v_tx.amount; v_cur := v_tx.user_id;

  for v_level in 1..3 loop
    select referred_by into v_ben from public.profiles where id = v_cur;   -- one hop up
    if v_ben is null then exit; end if;
    select role into v_role from public.profiles where id = v_ben and site_id = v_site;
    if v_role is null then exit; end if;                                    -- cross-site guard

    v_rate := case
      when v_level = 1 and v_role = 'marketer' then 0.25
      when v_level = 1 and v_role = 'player'   then 0.05
      when v_level = 2 and v_role = 'marketer' then 0.20
      when v_level = 3 and v_role = 'marketer' then 0.17
      else 0 end;

    if v_rate > 0 then
      v_comm := floor(v_amt * v_rate)::bigint;
      if v_comm > 0 then
        insert into public.deposit_commissions(deposit_tx_id, site_id, referred_user, beneficiary_user,
                                               level, beneficiary_role, rate, deposit_amount, commission_amount)
          values (p_deposit_tx, v_site, v_tx.user_id, v_ben, v_level, v_role, v_rate, v_amt, v_comm)
          on conflict (deposit_tx_id, level) do nothing;
        if found then   -- inserted (not a re-run) -> credit instantly
          update public.wallets set real_balance = real_balance + v_comm
            where user_id = v_ben and site_id = v_site;
          insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
            values (v_ben, v_site, 'affiliate_commission', v_comm, 'real', 'deposit_commissions', p_deposit_tx::text,
                    jsonb_build_object('level', v_level, 'rate', v_rate, 'referred_user', v_tx.user_id, 'deposit_amount', v_amt));
          v_created := v_created + 1;
        end if;
      end if;
    end if;

    v_cur := v_ben;   -- keep walking up
  end loop;
  return v_created;
end;
$fn$;
revoke all on function public.fn_pay_referral_commissions(uuid) from public, anon, authenticated;
grant execute on function public.fn_pay_referral_commissions(uuid) to service_role;

-- ── 4. Assign a code on registration + attribute via ANY user's code (not just affiliates) ──────
create or replace function public.fn_register_user(
  p_phone text, p_username text, p_password_hash text,
  p_referral_code text default null,
  p_site_id uuid default '00000000-0000-0000-0000-000000000001'
)
returns table(user_id uuid, role text)
language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid; v_aff uuid; v_code text;
begin
  if p_phone is null or length(p_phone) < 8 then raise exception 'INVALID_PHONE'; end if;
  if p_username is null or length(p_username) < 3 then raise exception 'INVALID_USERNAME'; end if;
  if p_password_hash is null or length(p_password_hash) < 20 then raise exception 'INVALID_HASH'; end if;
  if not exists (select 1 from sites s where s.id = p_site_id) then raise exception 'SITE_NOT_FOUND'; end if;
  if exists (select 1 from profiles where phone = p_phone and site_id = p_site_id) then raise exception 'PHONE_TAKEN'; end if;
  if exists (select 1 from profiles where username = p_username and site_id = p_site_id) then raise exception 'USERNAME_TAKEN'; end if;

  insert into profiles(phone, username, site_id, referral_code)
    values (p_phone, p_username, p_site_id, public.fn_gen_referral_code())
    returning id into v_id;
  insert into wallets(user_id, site_id) values (v_id, p_site_id);
  insert into user_credentials(user_id, password_hash) values (v_id, p_password_hash);

  -- First-touch, permanent attribution — resolved via ANY user's code (players can refer too),
  -- within this brand.
  v_code := nullif(upper(btrim(p_referral_code)), '');
  if v_code is not null then
    -- Resolve the referrer by EITHER their per-user profile code OR their affiliate code (so both
    -- player referral links and existing marketer/affiliate links attribute), within this brand.
    select coalesce(
      (select pr.id from profiles pr
         where pr.referral_code = v_code and pr.site_id = p_site_id and pr.status <> 'banned'),
      (select a.user_id from affiliates a
         where a.referral_code = v_code and a.status = 'active' and a.site_id = p_site_id)
    ) into v_aff;
    if v_aff is not null and v_aff <> v_id then
      update profiles set referred_by = v_aff where id = v_id;
      -- keep the affiliate `referrals` reporting row when the referrer is an enrolled affiliate
      if exists (select 1 from affiliates a where a.user_id = v_aff and a.site_id = p_site_id) then
        insert into referrals(affiliate_id, referred_user, site_id) values (v_aff, v_id, p_site_id)
          on conflict do nothing;
      end if;
    end if;
  end if;

  return query select v_id, (select pr.role from profiles pr where pr.id = v_id);
exception
  when unique_violation then raise exception 'REGISTRATION_CONFLICT';
end
$fn$;

-- ── 5. Hook: pay commissions the instant a real deposit completes (callback + reconcile paths) ──
-- Re-creates the active 0048 completion RPC verbatim + a single PERFORM of the payout RPC on success.
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
    -- NEW: instant multi-level referral commissions on this real deposit (idempotent).
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
