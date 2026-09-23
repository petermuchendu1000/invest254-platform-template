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
$function$

