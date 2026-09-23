create or replace view public.v_demo_profiles with (security_invoker=true) as  SELECT id,
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
