-- 0135_platform_admin_money_pii.sql — extend money/PII RPCs to a PLATFORM admin, platform-bounded.
--
-- Issue 1 (final scope item). 0133 made role/status platform-aware. This does the same for the
-- money/PII levers a Platform Admin needs over its own platform's players:
--   • fn_admin_adjust_balance        (real-balance adjust)
--   • fn_admin_adjust_balance_kind   (real/bonus/demo adjust)
--   • fn_admin_set_user_overrides    (per-user win-rate / house-edge / limits)
--
-- For a `platform_admin` actor each RPC now (a) is accepted, and (b) refuses any target whose brand
-- is OUTSIDE the actor's platform (PLATFORM_SCOPE_FORBIDDEN) — read in-definer from the actor's own
-- profiles.platform_id, so it cannot be spoofed. Every existing guard is preserved verbatim: the
-- OVERRIDE_FAVORS_PLAYER / range checks, INSUFFICIENT_FUNDS, REASON_REQUIRED, superadmin protection.
-- Platform-tier STAFF wallets (admin-tier and up) stay protected from balance edits. Also fixes a
-- latent gap: fn_admin_adjust_balance_kind previously rejected even platform_superadmin. Additive +
-- idempotent (create-or-replace). Bodies are the live 0134-era definitions + the platform branch.

-- ── 1. real-balance adjust ───────────────────────────────────────────────────────────────────────
create or replace function public.fn_admin_adjust_balance(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_reason text)
 returns TABLE(user_id uuid, amount bigint, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_bal bigint; v_new bigint; v_action bigint; v_actor_platform uuid;
begin
  if p_actor_role not in ('admin', 'platform_admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  -- Never adjust a platform-tier staff wallet (owner/system + platform admins).
  if (select role from profiles where id = p_target) in ('superadmin','platform_superadmin','platform_admin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- A PLATFORM admin may only act inside its own platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null or v_actor_platform is distinct from public.fn_user_platform(p_target) then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;
  select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set real_balance = wallets.real_balance + p_amount where wallets.user_id = p_target
    returning wallets.real_balance into v_new;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.adjust', 'user', p_target::text,
            jsonb_build_object('amount', p_amount, 'reason', p_reason, 'before', v_bal, 'after', v_new))
    returning id into v_action;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_target, 'adjustment', p_amount, 'real', 'admin_actions', v_action::text,
            jsonb_build_object('reason', p_reason, 'actor', p_actor));
  return query select p_target, p_amount, v_new;
end;
$function$;

-- ── 2. kinded (real/bonus/demo) adjust ───────────────────────────────────────────────────────────
create or replace function public.fn_admin_adjust_balance_kind(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_kind text, p_reason text)
 returns TABLE(user_id uuid, kind text, amount bigint, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_bal bigint; v_new bigint; v_action bigint; v_demo boolean; v_kind_eff text; v_actor_platform uuid;
begin
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_kind not in ('real','bonus') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  if (select role from profiles where id = p_target) in ('superadmin','platform_superadmin','platform_admin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null or v_actor_platform is distinct from public.fn_user_platform(p_target) then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;

  v_demo := (p_kind = 'real') and public.fn_is_marketer_account(p_target);
  v_kind_eff := case when v_demo then 'demo' when p_kind = 'real' then 'real' else 'bonus' end;

  if v_kind_eff = 'demo' then
    select w.demo_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = wallets.demo_balance + p_amount where wallets.user_id = p_target returning wallets.demo_balance into v_new;
  elsif v_kind_eff = 'real' then
    select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set real_balance = wallets.real_balance + p_amount where wallets.user_id = p_target returning wallets.real_balance into v_new;
  else
    select w.bonus_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set bonus_balance = wallets.bonus_balance + p_amount where wallets.user_id = p_target returning wallets.bonus_balance into v_new;
  end if;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.adjust', 'user', p_target::text,
            jsonb_build_object('kind', v_kind_eff, 'requested_kind', p_kind, 'amount', p_amount, 'reason', p_reason, 'before', v_bal, 'after', v_new))
    returning id into v_action;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_target, 'adjustment', p_amount, v_kind_eff, 'admin_actions', v_action::text,
            jsonb_build_object('reason', p_reason, 'actor', p_actor));
  return query select p_target, v_kind_eff, p_amount, v_new;
end;
$function$;

-- ── 3. per-user overrides (win-rate / house-edge / limits) ───────────────────────────────────────
create or replace function public.fn_admin_set_user_overrides(p_actor uuid, p_actor_role text, p_target uuid, p_patch jsonb)
 returns user_overrides
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.user_overrides; v_before jsonb; v_site uuid; v_site_edge numeric; v_site_maxmult numeric; v_site_wr numeric; v_actor_platform uuid;
begin
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select site_id into v_site from public.profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  -- A PLATFORM admin may only override users inside its own platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null or v_actor_platform is distinct from public.fn_user_platform(p_target) then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;

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
