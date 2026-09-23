CREATE OR REPLACE FUNCTION public.fn_create_deposit(p_user uuid, p_amount bigint, p_phone text)
 RETURNS uuid
 LANGUAGE sql
AS $function$ select public.fn_create_deposit($1,$2,$3,'00000000-0000-0000-0000-000000000001'::uuid); $function$

