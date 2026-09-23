CREATE OR REPLACE FUNCTION public.fn_create_withdrawal(p_user uuid, p_amount bigint, p_phone text, p_min bigint)
 RETURNS TABLE(tx_id uuid, new_balance bigint)
 LANGUAGE sql
AS $function$ select * from public.fn_create_withdrawal($1,$2,$3,$4,'00000000-0000-0000-0000-000000000001'::uuid); $function$

