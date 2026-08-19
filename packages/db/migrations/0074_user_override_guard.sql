-- 0074_user_override_guard.sql — stop per-user overrides from granting better-than-house economics.
--
-- Root-cause follow-up (docs/26 §5): per-user `user_overrides` let an admin set an ARBITRARY per-user
-- RTP. A player's realised RTP is 1 - (override house_edge ?? site house_edge); a per-user house_edge
-- BELOW the site's grants a favourable, house-losing edge to one player (a fairness/regulatory
-- landmine and an RTP distorter). This guard rejects that at the un-bypassable RPC chokepoint, and
-- validates ranges. Punitive (higher house_edge) and RTP-neutral win-rate tweaks remain allowed.
--
-- Rebased on the live 0061 body (actor gate + audit) with a validation block added before commit.
-- SECURITY DEFINER; idempotent (CREATE OR REPLACE). No data changed.

create or replace function public.fn_admin_set_user_overrides(p_actor uuid, p_actor_role text, p_target uuid, p_patch jsonb)
 returns user_overrides
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_row public.user_overrides; v_before jsonb; v_site uuid; v_site_edge numeric; v_site_maxmult numeric;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select site_id into v_site from public.profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  select to_jsonb(o) into v_before from public.user_overrides o where o.user_id = p_target;

  insert into public.user_overrides as u (user_id, site_id, win_rate, house_edge, trade_duration_s, max_win_multiplier, min_stake, max_stake, notes, updated_by, updated_at)
  values (
    p_target, v_site,
    case when p_patch ? 'win_rate'           then nullif(p_patch->>'win_rate','')::numeric        else null end,
    case when p_patch ? 'house_edge'         then nullif(p_patch->>'house_edge','')::numeric      else null end,
    case when p_patch ? 'trade_duration_s'   then nullif(p_patch->>'trade_duration_s','')::int    else null end,
    case when p_patch ? 'max_win_multiplier' then nullif(p_patch->>'max_win_multiplier','')::numeric else null end,
    case when p_patch ? 'min_stake'          then nullif(p_patch->>'min_stake','')::bigint        else null end,
    case when p_patch ? 'max_stake'          then nullif(p_patch->>'max_stake','')::bigint        else null end,
    case when p_patch ? 'notes'              then nullif(p_patch->>'notes','')                    else null end,
    p_actor, now()
  )
  on conflict (user_id) do update set
    site_id            = v_site,
    win_rate           = case when p_patch ? 'win_rate'           then nullif(p_patch->>'win_rate','')::numeric        else u.win_rate end,
    house_edge         = case when p_patch ? 'house_edge'         then nullif(p_patch->>'house_edge','')::numeric      else u.house_edge end,
    trade_duration_s   = case when p_patch ? 'trade_duration_s'   then nullif(p_patch->>'trade_duration_s','')::int    else u.trade_duration_s end,
    max_win_multiplier = case when p_patch ? 'max_win_multiplier' then nullif(p_patch->>'max_win_multiplier','')::numeric else u.max_win_multiplier end,
    min_stake          = case when p_patch ? 'min_stake'          then nullif(p_patch->>'min_stake','')::bigint        else u.min_stake end,
    max_stake          = case when p_patch ? 'max_stake'          then nullif(p_patch->>'max_stake','')::bigint        else u.max_stake end,
    notes              = case when p_patch ? 'notes'              then nullif(p_patch->>'notes','')                    else u.notes end,
    updated_by = p_actor, updated_at = now()
  returning * into v_row;

  -- ── Guard (docs/26 §5): never grant better-than-house economics; validate ranges ──
  if v_row.win_rate is not null and (v_row.win_rate <= 0 or v_row.win_rate > 1) then
    raise exception 'INVALID_OVERRIDE: win_rate must be in (0,1]';
  end if;
  if v_row.house_edge is not null and (v_row.house_edge < 0 or v_row.house_edge >= 1) then
    raise exception 'INVALID_OVERRIDE: house_edge must be in [0,1)';
  end if;
  select house_edge, max_multiplier into v_site_edge, v_site_maxmult from public.site_game_config where site_id = v_site;
  if v_row.house_edge is not null and v_site_edge is not null and v_row.house_edge < v_site_edge then
    raise exception 'OVERRIDE_FAVORS_PLAYER: per-user house_edge % is below the site house_edge % (would grant better-than-house RTP)', v_row.house_edge, v_site_edge;
  end if;
  if v_row.max_win_multiplier is not null and (v_row.max_win_multiplier <= 1
     or (v_site_maxmult is not null and v_row.max_win_multiplier > v_site_maxmult)) then
    raise exception 'INVALID_OVERRIDE: max_win_multiplier must be in (1, site max_multiplier]';
  end if;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.overrides', 'user', p_target::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$;
