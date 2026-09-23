-- 0159_operators_never_affiliates.sql — docs/42 UI-12 (BUGLOG #58).
--
-- Owner decision 2026-09-23: operators are never affiliates. An operator (site admin, platform admin,
-- system admin) earning revenue share on players they can see and manage is a conflict of interest.
-- The API refuses every player-side earning route for operator tokens (requireEarningRole); this is the
-- matching database fence, so no code path (role-change auto-enrol, a future caller) can do it either:
--
--   * fn_affiliate_enroll   refuses an operator profile (OPERATOR_NOT_ELIGIBLE) and KEEPS the player's
--                           existing referral code as the affiliate code (enrolment used to replace it,
--                           breaking every link the player had already shared — found in DRIFT-1);
--   * fn_register_user      attributes a sign-up only to a player/marketer referrer;
--   * fn_pay_referral_commissions  the instant 5% perk pays only a referrer whose role is 'player'
--                           (was `<> 'marketer'`, which included every operator tier);
--   * fn_accrue_affiliate_commissions  GGR revenue share accrues only to player/marketer affiliates;
--   * fn_gen_referral_code  also avoids other users' affiliate codes (no ambiguous attribution).
--
-- Bodies are the production-equal definitions from 0158 / 0117 with ONLY the changes marked "UI-12".
-- Production at the time: no operator affiliates, no operator-referred players, 0 commissions.
-- CREATE OR REPLACE keeps each function's grants; they are re-asserted below. Idempotent.

CREATE OR REPLACE FUNCTION public.fn_gen_referral_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare alphabet text := '23456789ABCDEFGHJKMNPQRSTVWXYZ'; code text; i int;
begin
  loop
    code := '';
    for i in 1..7 loop code := code || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
    -- UI-12: a profile code must never equal ANOTHER user's affiliate code either (registration
    -- resolves both kinds; a collision would attribute a sign-up to the wrong person).
    exit when not exists (select 1 from public.profiles where referral_code = code)
          and not exists (select 1 from public.affiliates a where a.referral_code = code);
  end loop;
  return code;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_register_user(p_phone text, p_username text, p_password_hash text, p_referral_code text DEFAULT NULL::text, p_site_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS TABLE(user_id uuid, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         where pr.referral_code = v_code and pr.site_id = p_site_id and pr.status <> 'banned'
           and pr.role in ('player','marketer')),          -- UI-12: operators never refer
      (select a.user_id from affiliates a join profiles ap on ap.id = a.user_id
         where a.referral_code = v_code and a.status = 'active' and a.site_id = p_site_id
           and ap.role in ('player','marketer'))
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_affiliate_enroll(p_user uuid)
 RETURNS TABLE(referral_code text, commission_rate numeric, status text, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text; i int; v_site uuid;
  v_rc text; v_rate numeric; v_status text; v_role text; v_prof_role text; v_prof_code text;
begin
  select site_id, profiles.role, profiles.referral_code into v_site, v_prof_role, v_prof_code
    from profiles where id = p_user;
  if v_site is null then raise exception 'USER_NOT_FOUND'; end if;
  -- UI-12: operators (admin / platform_admin / platform_superadmin) are never affiliates.
  if v_prof_role not in ('player','marketer') then raise exception 'OPERATOR_NOT_ELIGIBLE'; end if;
  if not exists (select 1 from affiliates where user_id = p_user) then
    -- UI-12: KEEP the code the player may already have shared — the affiliate code becomes their
    -- existing profile code (production's enrolment replaced it, silently breaking every link the
    -- player had shared). A new code is minted only when there is none, or it is somehow taken.
    if v_prof_code is not null and not exists (select 1 from affiliates a where a.referral_code = v_prof_code) then
      v_code := v_prof_code;
    else
    loop
      v_code := '';
      for i in 1..8 loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
      end loop;
      exit when not exists (select 1 from affiliates a where a.referral_code = v_code)
            and not exists (select 1 from profiles p where p.referral_code = v_code);
    end loop;
    end if;
    insert into affiliates(user_id, referral_code, site_id) values (p_user, v_code, v_site);
    update profiles set role = 'marketer' where id = p_user and profiles.role = 'player';
    -- unify: the marketer's public code becomes their affiliate code
    update profiles set referral_code = v_code where id = p_user;
  end if;
  select a.referral_code, a.commission_rate, a.status, pr.role
    into v_rc, v_rate, v_status, v_role
    from affiliates a join profiles pr on pr.id = a.user_id
   where a.user_id = p_user;
  return query select v_rc, v_rate, v_status, v_role;
end
$function$;

CREATE OR REPLACE FUNCTION public.fn_accrue_affiliate_commissions(p_period date, p_site_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(buckets integer, total_commission bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_buckets integer; v_total bigint;
begin
  with ggr as (
    select pr.referred_by as affiliate_id,
           p.user_id       as referred_user,
           p.site_id       as site_id,
           greatest(0, sum(p.stake - p.payout))::bigint as ggr
      from positions p
      join profiles  pr on pr.id = p.user_id
      join game_days gd on gd.id = p.game_day_id
     where p.status = 'settled'
       and gd.trade_date = p_period
       and pr.referred_by is not null
       and (p_site_id is null or p.site_id = p_site_id)
     group by pr.referred_by, p.user_id, p.site_id
  ),
  upserted as (
    insert into affiliate_commissions (affiliate_id, referred_user, period, ggr, commission, status, site_id)
    select g.affiliate_id, g.referred_user, p_period, g.ggr,
           floor(g.ggr * a.commission_rate)::bigint, 'accrued', g.site_id
      from ggr g
      -- an affiliate is ONLY credited for GGR earned on their own brand (defence-in-depth: a
      -- referred_user always shares the affiliate's site, but this join makes cross-brand
      -- accrual structurally impossible).
      join affiliates a on a.user_id = g.affiliate_id and a.site_id = g.site_id
      -- UI-12: an affiliate later made an operator stops earning (row kept for history/reversal).
      join profiles ap on ap.id = a.user_id and ap.role in ('player','marketer')
     where g.ggr > 0
    on conflict (site_id, affiliate_id, referred_user, period) do update
      set ggr = excluded.ggr, commission = excluded.commission
      where affiliate_commissions.status = 'accrued'   -- never touch paid/reversed buckets
    returning commission
  )
  select count(*)::integer, coalesce(sum(commission), 0)::bigint into v_buckets, v_total from upserted;
  return query select v_buckets, v_total;
end;
$function$;

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

  -- (a) Retail PLAYER referral perk: if the direct referrer is a PLAYER, pay them 5% instantly into
  --     their spendable wallet. ADDITIVE to the marketer 25% below. UI-12: only role='player' — the
  --     old `<> 'marketer'` test also paid admins / platform admins / the system admin.
  if v_direct is not null and v_direct <> v_depositor then
    select role into v_direct_role from public.profiles where id = v_direct and site_id = v_site;
    if v_direct_role = 'player' then
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

revoke all on function public.fn_gen_referral_code() from public, anon, authenticated;
grant execute on function public.fn_gen_referral_code() to service_role;
revoke all on function public.fn_pay_referral_commissions(uuid) from public, anon, authenticated;
grant execute on function public.fn_pay_referral_commissions(uuid) to service_role;
