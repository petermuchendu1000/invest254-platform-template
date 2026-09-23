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
end $function$

