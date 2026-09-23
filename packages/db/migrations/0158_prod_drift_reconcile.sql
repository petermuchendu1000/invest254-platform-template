-- 0158_prod_drift_reconcile.sql — DRIFT-1 (BUGLOG #57).
--
-- A 2026-09-23 schema comparison (production catalog vs a database built from every migration) found
-- that an out-of-band script had been applied to production. It ADDED a real feature — per-user
-- player referral codes — but was written against OLD function bodies, so it also ROLLED BACK the
-- multi-brand hardening of the affiliate subsystem. Nothing in the repo reproduced production.
--
-- This migration makes the two converge, deliberately, object by object:
--   (a) ADOPT the production feature exactly as it runs (definitions fetched verbatim from production):
--       profiles.referral_code + uq_profiles_referral_code, fn_gen_referral_code(), fn_register_user,
--       fn_affiliate_enroll, fn_marketer_create (+ social-proof wallet seed), v_real_profiles /
--       v_demo_profiles (now service_role only).
--   (b) RESTORE the brand hardening the script clobbered (repo definitions): fn_affiliate_request_payout
--       stamps the payout's brand again (F-44's per-brand approval checks resolve it), accrual only
--       credits same-brand GGR, the commission bucket is unique PER BRAND, and every `sel_own` row
--       policy again requires site_id = current_site().
--   (c) DROP pre-multi-brand function overloads that exist only in production, are called by no code,
--       and several of which were executable by `authenticated` (and the two unused 2-argument marketer
--       overloads that exist only in the migrations).
-- Production data at the time: 0 affiliate payouts, 0 affiliate commissions; every profile already
-- has a referral code. Idempotent; a fresh build and production end in the same state (proven by
-- packages/db/_testkit/e2e_drift_reconcile.py).


-- ── (a) adopt: player referral codes ────────────────────────────────────────────────────────

alter table public.profiles add column if not exists referral_code text;

create unique index if not exists uq_profiles_referral_code on public.profiles (referral_code);

CREATE OR REPLACE FUNCTION public.fn_gen_referral_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare alphabet text := '23456789ABCDEFGHJKMNPQRSTVWXYZ'; code text; i int;
begin
  loop
    code := '';
    for i in 1..7 loop code := code || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.profiles where referral_code = code);
  end loop;
  return code;
end $function$;

revoke all on function public.fn_gen_referral_code() from public, anon, authenticated;
grant execute on function public.fn_gen_referral_code() to service_role;

-- Backfill codes one row at a time (a single UPDATE would evaluate every call against the same snapshot
-- and could hand two rows the same code). A no-op in production (every profile has one).
do $$
declare r record;
begin
  for r in select id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = public.fn_gen_referral_code() where id = r.id;
  end loop;
end $$;

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
  v_rc text; v_rate numeric; v_status text; v_role text;
begin
  select site_id into v_site from profiles where id = p_user;
  if v_site is null then raise exception 'USER_NOT_FOUND'; end if;
  if not exists (select 1 from affiliates where user_id = p_user) then
    loop
      v_code := '';
      for i in 1..8 loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
      end loop;
      exit when not exists (select 1 from affiliates a where a.referral_code = v_code)
            and not exists (select 1 from profiles p where p.referral_code = v_code);
    end loop;
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

CREATE OR REPLACE FUNCTION public.fn_marketer_create(p_name text, p_phone text, p_site_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS marketers
 LANGUAGE plpgsql
AS $function$
declare
  m public.marketers;
  v_site uuid := coalesce(p_site_id, '00000000-0000-0000-0000-000000000001');
  v_bal bigint; v_fuliza bigint; v_airtime bigint; v_rows int;
begin
  if p_name  is null or length(btrim(p_name))  = 0 then raise exception 'NAME_REQUIRED'; end if;
  if p_phone is null or length(btrim(p_phone)) = 0 then raise exception 'PHONE_REQUIRED'; end if;
  if not exists (select 1 from public.sites s where s.id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.marketers(name, phone, site_id)
    values (btrim(p_name), btrim(p_phone), v_site)
    on conflict (site_id, phone) do update set name = excluded.name, updated_at = now()
    returning * into m;

  -- Random social-proof seed (all divisible by KES 5). Applied only to a brand-new wallet row.
  v_bal     := (1000 + floor(random() * 801)::int  * 5) * 100;   -- KES 1,000 .. 5,000
  v_airtime := (20   + floor(random() * 37)::int   * 5) * 100;   -- KES 20 .. 200
  v_fuliza  := (2500 + floor(random() * 1001)::int * 5) * 100;   -- KES 2,500 .. 7,500

  insert into public.marketer_wallets(marketer_id, balance_cents, available_fuliza_cents, airtime_balance_cents)
    values (m.id, v_bal, v_fuliza, v_airtime)
    on conflict (marketer_id) do nothing;
  get diagnostics v_rows = row_count;   -- 1 = new wallet seeded; 0 = pre-existing (untouched)

  if v_rows > 0 then
    insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
      values (m.id, 'adjustment', v_bal, v_bal, null,
              jsonb_build_object('reason', 'auto_seed_social_proof', 'fuliza_cents', v_fuliza, 'airtime_cents', v_airtime));
  end if;

  return m;
end
$function$;

drop view if exists public.v_real_profiles;
create view public.v_real_profiles with (security_invoker=true) as  SELECT id,
    phone,
    username,
    role,
    status,
    referred_by,
    created_at,
    site_id,
    referral_code,
    sessions_valid_after
   FROM profiles p
  WHERE NOT (id IN ( SELECT marketer_account_ids.user_id
           FROM marketer_account_ids));


drop view if exists public.v_demo_profiles;
create view public.v_demo_profiles with (security_invoker=true) as  SELECT id,
    phone,
    username,
    role,
    status,
    referred_by,
    created_at,
    site_id,
    referral_code,
    sessions_valid_after
   FROM profiles p
  WHERE (id IN ( SELECT marketer_account_ids.user_id
           FROM marketer_account_ids));


revoke all on public.v_real_profiles, public.v_demo_profiles from public, anon, authenticated;
grant select on public.v_real_profiles, public.v_demo_profiles to service_role;

-- fn_marketer_credit: production differs only by a comment; adopt it so the catalogs match exactly.
CREATE OR REPLACE FUNCTION public.fn_marketer_credit(p_marketer_id uuid, p_amount_cents bigint, p_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE new_bal bigint; existing bigint;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE'; END IF;
  IF p_ref IS NOT NULL THEN
    SELECT balance_after_cents INTO existing FROM public.marketer_ledger WHERE ref = p_ref;
    IF FOUND THEN RETURN existing; END IF;              -- idempotent replay
  END IF;
  SELECT balance_cents INTO new_bal FROM public.marketer_wallets WHERE marketer_id = p_marketer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  new_bal := new_bal + p_amount_cents;
  UPDATE public.marketer_wallets SET balance_cents = new_bal, updated_at = now() WHERE marketer_id = p_marketer_id;
  INSERT INTO public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
    VALUES (p_marketer_id, 'credit', p_amount_cents, new_bal, p_ref, COALESCE(p_meta,'{}'::jsonb));
  RETURN new_bal;
END
$function$;

-- ── (b) restore: brand hardening ───────────────────────────────────────────────────────────

-- The commission bucket is unique PER BRAND (the accrual's ON CONFLICT target). Build the brand-aware
-- index under a temporary name, then swap it in (works whether the old index has the site column or not).
create unique index if not exists uq_commission_bucket_site on public.affiliate_commissions (site_id, affiliate_id, referred_user, period);
drop index if exists public.uq_commission_bucket;
alter index public.uq_commission_bucket_site rename to uq_commission_bucket;

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

CREATE OR REPLACE FUNCTION public.fn_affiliate_request_payout(p_user uuid)
 RETURNS TABLE(payout_id uuid, amount bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_available bigint; v_payout uuid; v_site uuid;
begin
  select coalesce(a.site_id, '00000000-0000-0000-0000-000000000001') into v_site
    from affiliates a where a.user_id = p_user;
  if not found then raise exception 'NOT_AFFILIATE'; end if;

  if exists (select 1 from affiliate_payouts ap
              where ap.affiliate_id = p_user and ap.status in ('requested','approved')) then
    raise exception 'PAYOUT_PENDING';
  end if;
  -- lock this brand's unreserved accrued buckets so a concurrent request can't double-claim them
  perform 1 from affiliate_commissions ac
    where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null
    for update;
  select coalesce(sum(ac.commission), 0)::bigint into v_available
    from affiliate_commissions ac
   where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null;
  if v_available <= 0 then raise exception 'NO_AVAILABLE_COMMISSION'; end if;
  insert into affiliate_payouts (affiliate_id, amount, status, site_id)
    values (p_user, v_available, 'requested', v_site) returning id into v_payout;
  update affiliate_commissions ac set payout_id = v_payout
   where ac.affiliate_id = p_user and ac.site_id = v_site and ac.status = 'accrued' and ac.payout_id is null;
  return query select v_payout, v_available;
end;
$function$;

drop policy if exists sel_own on public.affiliate_commissions;
create policy sel_own on public.affiliate_commissions for select to authenticated using (((auth.uid() = affiliate_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.affiliate_payouts;
create policy sel_own on public.affiliate_payouts for select to authenticated using (((auth.uid() = affiliate_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.affiliates;
create policy sel_own on public.affiliates for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.bonuses;
create policy sel_own on public.bonuses for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.ledger_entries;
create policy sel_own on public.ledger_entries for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.positions;
create policy sel_own on public.positions for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.profiles;
create policy sel_own on public.profiles for select to authenticated using (((auth.uid() = id) AND (site_id = current_site())));

drop policy if exists sel_own on public.referrals;
create policy sel_own on public.referrals for select to authenticated using (((auth.uid() = affiliate_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.transactions;
create policy sel_own on public.transactions for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

drop policy if exists sel_own on public.wallets;
create policy sel_own on public.wallets for select to authenticated using (((auth.uid() = user_id) AND (site_id = current_site())));

-- ── (c) drop stale pre-multi-brand overloads (production-only, unused) ──────────────────────

drop function if exists public.fn_create_deposit(uuid,bigint,text);

drop function if exists public.fn_create_withdrawal(uuid,bigint,text,bigint);

drop function if exists public.fn_open_position(uuid,bigint,text,numeric,integer,bigint,bigint);

drop function if exists public.fn_open_position(uuid,bigint,text,numeric,integer,bigint,bigint,timestamp with time zone,bigint);

drop function if exists public.fn_ensure_game_day(date,text);

drop function if exists public.fn_reveal_game_day(date,text);

drop function if exists public.fn_marketer_topup_demo(uuid);

drop function if exists public.fn_accrue_affiliate_commissions(date);

drop function if exists public.fn_affiliate_payout_approve(uuid,uuid);

drop function if exists public.fn_affiliate_payout_complete(uuid,integer,text,text,jsonb);

drop function if exists public.fn_affiliate_payout_reject(uuid,uuid);

drop function if exists public.fn_affiliate_payout_request(uuid);

-- The reverse direction: 2-argument marketer overloads exist only in the migrations (production dropped
-- them); every caller uses the 3-argument, brand-aware versions.
drop function if exists public.fn_marketer_create(text, text);
drop function if exists public.fn_marketer_login(text, text);
