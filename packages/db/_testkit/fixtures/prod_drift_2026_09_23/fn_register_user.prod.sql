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
$function$

