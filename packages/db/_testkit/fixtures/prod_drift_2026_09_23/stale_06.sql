CREATE OR REPLACE FUNCTION public.fn_reveal_game_day(p_date date, p_seed text)
 RETURNS boolean
 LANGUAGE sql
AS $function$ select public.fn_reveal_game_day($1,$2,'00000000-0000-0000-0000-000000000001'::uuid); $function$

