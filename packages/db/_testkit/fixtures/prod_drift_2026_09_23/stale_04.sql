CREATE OR REPLACE FUNCTION public.fn_open_position(p_user uuid, p_stake bigint, p_direction text, p_entry_rate numeric, p_duration_s integer, p_game_day bigint, p_nonce bigint, p_opened_at timestamp with time zone, p_config_version bigint)
 RETURNS TABLE(position_id uuid, new_balance bigint)
 LANGUAGE sql
AS $function$
        select * from public.fn_open_position($1,$2,$3,$4,$5,$6,$7,$8,$9,'00000000-0000-0000-0000-000000000001'::uuid);
      $function$

