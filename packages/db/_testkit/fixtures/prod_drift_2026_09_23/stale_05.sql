CREATE OR REPLACE FUNCTION public.fn_ensure_game_day(p_date date, p_hash text)
 RETURNS bigint
 LANGUAGE sql
AS $function$ select public.fn_ensure_game_day($1,$2,'00000000-0000-0000-0000-000000000001'::uuid); $function$

