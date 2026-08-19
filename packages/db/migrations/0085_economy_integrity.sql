-- 0085_economy_integrity.sql — close the three economy-integrity gaps found by the calibration
-- diagnosis (docs/28 §4). The settlement engine is CORRECT; these guards stop the OPERATIONAL causes
-- of the live >100% cohort RTP and the provable-fairness breakage. Additive, idempotent, revertible.
--
--   1. Override win-rate guard — 0074 blocked only a favourable per-user house_edge; a favourable
--      per-user WIN_RATE (above the site target) is still an arbitrary per-user win-frequency lever
--      (the fairness/regulatory anti-pattern that produced the ~90% cohort win-rates). Reject it.
--   2. Config-change rate limit — operators thrashed site_game_config (bursts of swings in minutes).
--      Cap changes per rolling HOUR per brand at the un-bypassable versions-insert chokepoint.
--   3. Version immutability — 1,606/3,785 settled positions (42%) referenced a PRUNED
--      site_game_config_versions row, so their outcome can't be recomputed/verified/recovered. Make
--      the versions table append-only (no UPDATE/DELETE) so provenance can never be destroyed again.
--   4. Data: back up + clear FAVOURABLE overrides going forward (win_rate above site target, or
--      house_edge below site edge). Punitive overrides are left intact.

-- ── 1. Override win-rate guard (rebased on the live 0074 body; adds the win_rate favourability check) ──
create or replace function public.fn_admin_set_user_overrides(p_actor uuid, p_actor_role text, p_target uuid, p_patch jsonb)
 returns user_overrides language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.user_overrides; v_before jsonb; v_site uuid; v_site_edge numeric; v_site_maxmult numeric; v_site_wr numeric;
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

  -- Guard: never grant better-than-house ECONOMICS or better-than-site WIN-FREQUENCY; validate ranges.
  if v_row.win_rate is not null and (v_row.win_rate <= 0 or v_row.win_rate > 1) then
    raise exception 'INVALID_OVERRIDE: win_rate must be in (0,1]';
  end if;
  if v_row.house_edge is not null and (v_row.house_edge < 0 or v_row.house_edge >= 1) then
    raise exception 'INVALID_OVERRIDE: house_edge must be in [0,1)';
  end if;
  select house_edge, max_multiplier, target_win_rate into v_site_edge, v_site_maxmult, v_site_wr
    from public.site_game_config where site_id = v_site;
  if v_row.house_edge is not null and v_site_edge is not null and v_row.house_edge < v_site_edge then
    raise exception 'OVERRIDE_FAVORS_PLAYER: per-user house_edge % is below the site house_edge % (better-than-house RTP)', v_row.house_edge, v_site_edge;
  end if;
  -- NEW: a per-user win_rate ABOVE the site target favours the player (arbitrary win-frequency lever).
  if v_row.win_rate is not null and v_site_wr is not null and v_row.win_rate > v_site_wr then
    raise exception 'OVERRIDE_FAVORS_PLAYER: per-user win_rate % is above the site target_win_rate % (arbitrary favourable win-frequency lever)', v_row.win_rate, v_site_wr;
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

-- ── 2. Config-change rate limit (per brand, rolling 24h) at the versions-insert chokepoint ──────────
-- MAX_CONFIG_CHANGES_PER_HOUR curbs runaway BURST thrash (the real failure mode: many swings in
-- minutes) without freezing deliberate, spaced tuning — a rolling-24h cap would have frozen config for
-- ~17h after the historical thrash. Superadmin can still edit; this only stops rapid churn.
create or replace function public.fn_guard_config_change_rate()
returns trigger language plpgsql set search_path = public as $fn$
declare v_recent int; v_cap constant int := 6;
begin
  select count(*) into v_recent from public.site_game_config_versions
   where site_id = NEW.site_id and created_at > now() - interval '1 hour';
  if v_recent >= v_cap then
    raise exception 'CONFIG_CHANGE_RATE_LIMIT: % economy changes in the last hour for this brand (cap %). Slow down / review before more edits.', v_recent, v_cap;
  end if;
  return NEW;
end $fn$;
drop trigger if exists trg_config_change_rate on public.site_game_config_versions;
create trigger trg_config_change_rate before insert on public.site_game_config_versions
  for each row execute function public.fn_guard_config_change_rate();

-- ── 3. Version immutability (append-only) — provenance can never be pruned again ────────────────────
create or replace function public.fn_config_versions_immutable()
returns trigger language plpgsql set search_path = public as $fn$
begin
  raise exception 'CONFIG_VERSION_IMMUTABLE: site_game_config_versions is append-only (attempted %); pruning/editing breaks provable-fairness + crash recovery', TG_OP;
end $fn$;
drop trigger if exists trg_config_versions_immutable on public.site_game_config_versions;
create trigger trg_config_versions_immutable before update or delete on public.site_game_config_versions
  for each row execute function public.fn_config_versions_immutable();

-- ── 4. Back up + clear FAVOURABLE overrides (punitive ones kept) ────────────────────────────────────
create table if not exists public.user_overrides_backup_0085 (like public.user_overrides including all);
insert into public.user_overrides_backup_0085
  select o.* from public.user_overrides o
  join public.site_game_config g on g.site_id = o.site_id
  where (o.house_edge is not null and o.house_edge < g.house_edge)
     or (o.win_rate  is not null and o.win_rate  > g.target_win_rate)
  on conflict do nothing;
delete from public.user_overrides o
  using public.site_game_config g
  where g.site_id = o.site_id
    and ((o.house_edge is not null and o.house_edge < g.house_edge)
      or (o.win_rate  is not null and o.win_rate  > g.target_win_rate));

do $g$
begin
  revoke all on function public.fn_admin_set_user_overrides(uuid,text,uuid,jsonb) from public, anon, authenticated;
  grant  execute on function public.fn_admin_set_user_overrides(uuid,text,uuid,jsonb) to service_role;
end $g$;

-- ── REVERT (manual) ────────────────────────────────────────────────────────────────────────────────
--   drop trigger trg_config_change_rate on site_game_config_versions;
--   drop trigger trg_config_versions_immutable on site_game_config_versions;
--   insert into user_overrides select * from user_overrides_backup_0085 on conflict (user_id) do nothing;
--   restore fn_admin_set_user_overrides from migration 0074.
