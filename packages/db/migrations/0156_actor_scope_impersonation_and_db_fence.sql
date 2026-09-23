-- 0156_actor_scope_impersonation_and_db_fence.sql — Issue 1 / F-46 (BUGLOG #46).
--
-- TWO DEFECTS, ONE ROOT: the DB derived a site-tier actor's scope from its PROFILE, while the API
-- scopes by the TOKEN. They disagree whenever the token is not the profile:
--   (a) IMPERSONATION: a platform admin / the owner acts on brand X with a role='admin', site=X token,
--       but fn_actor_target_sites() resolved the actor's HOME brand — broadcasts, category clears and
--       tickets landed on the wrong brand (possibly another platform), and add-on requests for X failed.
--   (b) NO DB FENCE FOR SITE ADMINS: the user/money RPCs never checked the target's brand for
--       p_actor_role='admin' (only the platform_admin branch was fenced). The API was the only guard,
--       which is how a claimless site-admin token (BUGLOG #43) credited other brands' users in
--       production. A demoted admin on a stale token (prod: actor_role='admin', profile role 'player')
--       was likewise unfenced.
--
-- FIX — split PERMISSION from TARGETING, both verified against the actor's REAL profile:
--   fn_actor_scope_sites(actor, role)   PERMISSION: may this actor act on brand S?
--       platform_superadmin -> all; platform_admin -> its platform (both exactly as before);
--       role admin|superadmin -> genuine site admin (profile role admin): its brand;
--                                impersonating platform admin (profile platform_admin): its platform;
--                                impersonating owner (profile platform_superadmin): all;
--                                anyone else (demoted / stale token): NONE.
--   fn_actor_target_sites(actor, role)  TARGETING for untargeted bulk actions (same signature):
--       as before for genuine tiers; an IMPERSONATING or stale site-tier actor -> NONE (never its home).
--   fn_actor_bulk_sites(actor, role, audience) = audience.sites ∩ scope when brands are named, else
--       the targeting set. The API names the token's brand for every site-tier bulk action.
--   fn_assert_actor_site_scope(actor, role, site): SITE_SCOPE_FORBIDDEN for a site-tier actor acting
--       outside fn_actor_scope_sites — injected as the FIRST statement of the 17 user/brand/advance
--       RPCs (bodies otherwise byte-identical to production; verified by md5 before generation).
--   Add-ons use PERMISSION; audience/broadcast/category-clear use BULK; tickets use PERMISSION for an
--   explicit brand (impersonation) else the genuine admin's own brand; new 4-arg category clear.
-- DEPLOY-ORDER SAFE: under the previously deployed API (which never names a brand) an impersonated
-- bulk action reaches NOBODY (was: the wrong brand); genuine site admins, platform admins and the
-- owner behave exactly as before. Idempotent.

create or replace function public.fn_actor_scope_sites(p_actor uuid, p_actor_role text)
returns table(site_id uuid)
language sql stable security definer set search_path = public
as $fn$
  select s.id
    from public.sites s
    left join public.profiles a on a.id = p_actor
   where p_actor_role = 'platform_superadmin'                                          -- unchanged
      or (p_actor_role = 'platform_admin' and s.platform_id = a.platform_id)               -- unchanged
      or (p_actor_role in ('admin', 'superadmin') and (
             (a.role = 'admin' and s.id = a.site_id)
          or (a.role = 'platform_admin' and s.platform_id = a.platform_id)
          or (a.role = 'platform_superadmin')));
$fn$;

create or replace function public.fn_actor_target_sites(p_actor uuid, p_actor_role text)
returns table(site_id uuid)
language sql stable security definer set search_path = public
as $fn$
  select s.id
    from public.sites s
    left join public.profiles a on a.id = p_actor
   where p_actor_role = 'platform_superadmin'                                          -- unchanged
      or (p_actor_role = 'platform_admin' and s.platform_id = a.platform_id)               -- unchanged
      or (p_actor_role in ('admin', 'superadmin') and a.role = 'admin' and s.id = a.site_id);  -- F-46: genuine site admin only
$fn$;

create or replace function public.fn_actor_bulk_sites(p_actor uuid, p_actor_role text, p_audience jsonb)
returns table(site_id uuid)
language sql stable security definer set search_path = public
as $fn$
  select sc.site_id from public.fn_actor_scope_sites(p_actor, p_actor_role) sc
   where coalesce(p_audience, '{}'::jsonb) ? 'sites'
     and sc.site_id::text in (select jsonb_array_elements_text(p_audience -> 'sites'))
  union
  select t.site_id from public.fn_actor_target_sites(p_actor, p_actor_role) t
   where not (coalesce(p_audience, '{}'::jsonb) ? 'sites');
$fn$;

create or replace function public.fn_assert_actor_site_scope(p_actor uuid, p_actor_role text, p_site uuid)
returns void
language plpgsql stable security definer set search_path = public
as $fn$
begin
  -- Only site-tier actors are fenced here (platform tiers keep their own, existing checks). An
  -- unresolved target (null) is left to the calling function's own NOT_FOUND handling.
  if p_actor_role in ('admin', 'superadmin') and p_site is not null
     and not exists (select 1 from public.fn_actor_scope_sites(p_actor, p_actor_role) s where s.site_id = p_site) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
end;
$fn$;

-- ── The 17 fenced RPCs (production bodies + one injected first statement) ──

-- fn_admin_adjust_balance: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_adjust_balance(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_reason text)
 RETURNS TABLE(user_id uuid, amount bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_new bigint; v_action bigint; v_actor_platform uuid;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
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

-- fn_admin_adjust_balance_kind: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_adjust_balance_kind(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_kind text, p_reason text)
 RETURNS TABLE(user_id uuid, kind text, amount bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_new bigint; v_action bigint; v_demo boolean; v_kind_eff text; v_actor_platform uuid;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
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

-- fn_admin_clear_balance: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_clear_balance(p_actor uuid, p_actor_role text, p_target uuid, p_kind text, p_reason text)
 RETURNS TABLE(user_id uuid, real_balance bigint, bonus_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_real bigint; v_bonus bigint; v_demo bigint; v_action bigint; v_is_demo boolean; v_spend_kind text;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_kind not in ('real','bonus','both') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;

  select w.real_balance, w.bonus_balance, w.demo_balance into v_real, v_bonus, v_demo from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  v_is_demo := public.fn_is_marketer_account(p_target);
  v_spend_kind := case when v_is_demo then 'demo' else 'real' end;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.clear', 'user', p_target::text,
            jsonb_build_object('kind', p_kind, 'reason', p_reason, 'before_real', v_real, 'before_bonus', v_bonus, 'before_demo', v_demo, 'spend_kind', v_spend_kind))
    returning id into v_action;

  -- 'real'/'both' clears the account's SPENDABLE bucket: demo for a marketer, else real.
  if p_kind in ('real','both') then
    if v_is_demo and v_demo <> 0 then
      update wallets set demo_balance = 0 where wallets.user_id = p_target;
      insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (p_target, 'adjustment', -v_demo, 'demo', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
    elsif (not v_is_demo) and v_real <> 0 then
      update wallets set real_balance = 0 where wallets.user_id = p_target;
      insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (p_target, 'adjustment', -v_real, 'real', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
    end if;
  end if;
  if p_kind in ('bonus','both') and v_bonus <> 0 then
    update wallets set bonus_balance = 0 where wallets.user_id = p_target;
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', -v_bonus, 'bonus', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
  end if;

  select w.real_balance, w.bonus_balance, w.demo_balance into v_real, v_bonus, v_demo from wallets w where w.user_id = p_target;
  -- return the SPENDABLE balance in the real_balance slot (mirrors getBalance surfacing demo for marketers)
  return query select p_target, case when v_is_demo then v_demo else v_real end, v_bonus;
end;
$function$;

-- fn_admin_delete_user: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_delete_user(p_actor uuid, p_actor_role text, p_target uuid)
 RETURNS TABLE(user_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old text; v_target_role text;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.status, pr.role into v_old, v_target_role from profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  -- Idempotent: already deleted -> report and stop (no re-audit, no error).
  if v_old = 'deleted' then return query select p_target, 'deleted'::text; return; end if;

  -- Platform superadmins are never deletable here; a plain admin may not delete another admin.
  if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if v_target_role = 'admin' and p_actor_role not in ('superadmin','platform_superadmin') then
    raise exception 'INSUFFICIENT_PRIVILEGE';
  end if;
  -- A brand's default marketer must be reassigned before deletion (mirrors the status RPC).
  if exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;

  update profiles pr
     set status = 'deleted', sessions_valid_after = now()   -- force-logout every existing session
   where pr.id = p_target;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.delete', 'user', p_target::text,
            jsonb_build_object('from', v_old, 'to', 'deleted'));

  return query select p_target, 'deleted'::text;
end;
$function$;

-- fn_admin_reset_balance_to_last_funded: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_reset_balance_to_last_funded(p_actor uuid, p_actor_role text, p_target uuid, p_reason text)
 RETURNS TABLE(user_id uuid, last_funded bigint, previous_balance bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_last bigint; v_delta bigint; v_role text; v_action bigint;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;

  select role into v_role from profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;

  -- Original last funded amount = the most recent SUCCESSFUL deposit.
  -- Alias the table: the RETURNS TABLE out-column `user_id` would otherwise make `user_id` ambiguous.
  select tx.amount into v_last from transactions tx
    where tx.user_id = p_target and tx.kind = 'deposit' and tx.status = 'success'
    order by tx.created_at desc, tx.id desc limit 1;
  if v_last is null then raise exception 'NO_FUNDING'; end if;

  -- Lock the wallet, set real_balance to the last funded amount, reconcile via a ledger entry.
  select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  v_delta := v_last - v_bal;
  update wallets set real_balance = v_last where wallets.user_id = p_target;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.reset_last_funded', 'user', p_target::text,
            jsonb_build_object('reason', p_reason, 'before', v_bal, 'after', v_last,
                               'lastFunded', v_last, 'delta', v_delta))
    returning id into v_action;

  if v_delta <> 0 then
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', v_delta, 'real', 'admin_actions', v_action::text,
              jsonb_build_object('kind', 'reset_last_funded', 'reason', p_reason, 'actor', p_actor, 'lastFunded', v_last));
  end if;

  return query select p_target, v_last, v_bal, v_last;
end;
$function$;

-- fn_admin_set_commission_rate: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_set_commission_rate(p_actor uuid, p_actor_role text, p_target uuid, p_rate numeric)
 RETURNS TABLE(user_id uuid, commission_rate numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old numeric;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_rate < 0 or p_rate > 1 then raise exception 'INVALID_RATE'; end if;
  select a.commission_rate into v_old from affiliates a where a.user_id = p_target for update;
  if not found then raise exception 'NOT_AFFILIATE'; end if;
  update affiliates a set commission_rate = p_rate where a.user_id = p_target;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'affiliate.rate', 'affiliate', p_target::text,
            jsonb_build_object('from', v_old, 'to', p_rate));
  return query select p_target, p_rate;
end;
$function$;

-- fn_admin_set_user_overrides: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_set_user_overrides(p_actor uuid, p_actor_role text, p_target uuid, p_patch jsonb)
 RETURNS user_overrides
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.user_overrides; v_before jsonb; v_site uuid; v_site_edge numeric; v_site_maxmult numeric; v_site_wr numeric; v_actor_platform uuid;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
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

-- fn_admin_set_user_role: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
 RETURNS TABLE(user_id uuid, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old text; v_target_platform uuid; v_actor_platform uuid;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('player','marketer','admin') then raise exception 'INVALID_ROLE'; end if; -- platform_admin+ via dedicated RPCs
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if v_old = 'platform_admin' then raise exception 'PLATFORM_ADMIN_PROTECTED'; end if; -- use fn_platform_revoke_platform_admin
  -- A plain SITE admin is confined to the player<->marketer transition (cannot mint/lower admins).
  if p_actor_role = 'admin' and (p_role not in ('player','marketer') or v_old not in ('player','marketer')) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  -- A PLATFORM admin may manage player/marketer/admin, but only for users inside ITS OWN platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    v_target_platform := public.fn_user_platform(p_target);
    if v_target_platform is distinct from v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;
  -- Default-marketer lock (unchanged): a brand's default marketer must stay 'marketer'.
  if p_role <> 'marketer' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;

  update public.profiles pr set role = p_role, platform_id = null where pr.id = p_target;
  if p_role = 'marketer' then perform * from public.fn_affiliate_enroll(p_target); end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.set_role', 'user', p_target::text,
            jsonb_build_object('old', v_old, 'new', p_role));
  return query select p_target, p_role;
end;
$function$;

-- fn_admin_set_user_status: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_set_user_status(p_actor uuid, p_actor_role text, p_target uuid, p_status text, p_reason text)
 RETURNS TABLE(user_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old text; v_target_role text; v_target_platform uuid; v_actor_platform uuid;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','platform_admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('active','suspended','banned') then raise exception 'INVALID_STATUS'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.status, pr.role into v_old, v_target_role from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- Only the system owner may act on a platform_admin.
  if v_target_role = 'platform_admin' and p_actor_role <> 'platform_superadmin' then raise exception 'INSUFFICIENT_PRIVILEGE'; end if;
  -- A site/platform admin target may only be actioned by a platform_admin or higher.
  if v_target_role = 'admin' and p_actor_role not in ('platform_admin','superadmin','platform_superadmin') then raise exception 'INSUFFICIENT_PRIVILEGE'; end if;
  -- A PLATFORM admin is confined to users inside ITS OWN platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    v_target_platform := public.fn_user_platform(p_target);
    if v_target_platform is distinct from v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;
  if p_status <> 'active' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;
  update public.profiles pr set status = p_status where pr.id = p_target;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.status', 'user', p_target::text, jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  return query select p_target, p_status;
end;
$function$;

-- fn_admin_update_user: fenced on (select site_id from public.profiles where id = p_target)
CREATE OR REPLACE FUNCTION public.fn_admin_update_user(p_actor uuid, p_actor_role text, p_target uuid, p_phone text, p_username text)
 RETURNS TABLE(user_id uuid, phone text, username text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_site uuid; v_phone text; v_username text; v_cur record;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select pr.site_id, pr.phone, pr.username, pr.role into v_cur from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  -- A plain admin may not edit an admin/superadmin account.
  if p_actor_role = 'admin' and v_cur.role in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  v_site := v_cur.site_id;

  v_phone := nullif(public.fn_norm_phone(p_phone), '');
  v_username := nullif(btrim(coalesce(p_username, '')), '');

  if v_phone is not null then
    if v_phone !~ '^0[17][0-9]{8}$' then raise exception 'INVALID_PHONE'; end if;
    if exists (select 1 from public.profiles pr where pr.site_id = v_site and pr.phone = v_phone and pr.id <> p_target) then
      raise exception 'PHONE_TAKEN';
    end if;
  end if;
  if v_username is not null then
    if length(v_username) < 2 or length(v_username) > 40 then raise exception 'INVALID_USERNAME'; end if;
    if exists (select 1 from public.profiles pr where pr.site_id = v_site and lower(pr.username) = lower(v_username) and pr.id <> p_target) then
      raise exception 'USERNAME_TAKEN';
    end if;
  end if;

  update public.profiles pr
     set phone    = coalesce(v_phone, pr.phone),
         username = coalesce(v_username, pr.username)
   where pr.id = p_target
   returning pr.id, pr.phone, pr.username into user_id, phone, username;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.update_details', 'user', p_target::text,
            jsonb_build_object('phone', phone, 'username', username,
                               'old_phone', v_cur.phone, 'old_username', v_cur.username));
  return next;
end;
$function$;

-- fn_admin_set_default_pool: fenced on p_site
CREATE OR REPLACE FUNCTION public.fn_admin_set_default_pool(p_actor uuid, p_actor_role text, p_site uuid, p_amount bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, p_site);   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  update public.sites set default_daily_pool_cents = p_amount where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool.default.set', 'site', p_site::text,
            jsonb_build_object('default_daily_pool_cents', p_amount), p_site);
  return p_amount;
end;
$function$;

-- fn_admin_set_pool_mode: fenced on p_site
CREATE OR REPLACE FUNCTION public.fn_admin_set_pool_mode(p_actor uuid, p_actor_role text, p_site uuid, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, p_site);   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('superadmin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.sites set pool_mode = p_enabled, updated_at = now() where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool_mode.toggle', 'site', p_site::text,
            jsonb_build_object('pool_mode', p_enabled), p_site);
  return p_enabled;
end;
$function$;

-- fn_admin_set_site_game_config: fenced on p_site_id
CREATE OR REPLACE FUNCTION public.fn_admin_set_site_game_config(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 RETURNS site_game_config
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.site_game_config; v_before jsonb;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, p_site_id);   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_CONFIG'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;

  begin
    update public.site_game_config u set
      house_edge         = coalesce((p_patch->>'houseEdge')::numeric,          u.house_edge),
      max_multiplier     = coalesce((p_patch->>'maxMultiplier')::numeric,      u.max_multiplier),
      min_stake          = coalesce((p_patch->>'minStakeCents')::bigint,       u.min_stake),
      max_stake          = coalesce((p_patch->>'maxStakeCents')::bigint,       u.max_stake),
      min_withdrawal     = coalesce((p_patch->>'minWithdrawalCents')::bigint,  u.min_withdrawal),
      default_duration_s = coalesce((p_patch->>'defaultDurationS')::int,       u.default_duration_s),
      tick_rate_ms       = coalesce((p_patch->>'tickRateMs')::int,             u.tick_rate_ms),
      drift_bias         = coalesce((p_patch->>'driftBias')::numeric,          u.drift_bias),
      volatility         = coalesce((p_patch->>'volatility')::numeric,         u.volatility),
      target_win_rate    = coalesce((p_patch->>'targetWinRate')::numeric,      u.target_win_rate),
      updated_by         = p_actor
    where u.site_id = p_site_id
    returning * into v_row;
  exception
    when check_violation then raise exception 'INVALID_CONFIG';
    when invalid_text_representation or numeric_value_out_of_range or division_by_zero then raise exception 'INVALID_CONFIG';
  end;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'game.config', 'site_game_config', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)), p_site_id);
  return v_row;
end;
$function$;

-- fn_admin_set_withdrawal_pool: fenced on p_site
CREATE OR REPLACE FUNCTION public.fn_admin_set_withdrawal_pool(p_actor uuid, p_actor_role text, p_site uuid, p_day date, p_amount bigint)
 RETURNS withdrawal_pool
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.withdrawal_pool; v_before jsonb;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, p_site);   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'SITE_NOT_FOUND'; end if;
  select to_jsonb(w) into v_before from public.withdrawal_pool w where w.site_id=p_site and w.trade_day=p_day;

  insert into public.withdrawal_pool as w (site_id, trade_day, amount_cents, set_by, updated_at)
    values (p_site, p_day, p_amount, p_actor, now())
  on conflict (site_id, trade_day) do update
    set amount_cents = excluded.amount_cents, set_by = p_actor, updated_at = now()
    -- guard: cannot set the daily budget BELOW what has already been paid+reserved today
    where excluded.amount_cents >= w.paid_cents + w.reserved_cents
  returning * into v_row;

  if v_row.site_id is null then
    -- the WHERE on the DO UPDATE failed -> the new amount would underflow committed liability
    raise exception 'AMOUNT_BELOW_COMMITTED';
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'pool.set', 'withdrawal_pool', p_site::text || ':' || p_day::text,
            jsonb_build_object('before', v_before, 'after', to_jsonb(v_row)), p_site);
  return v_row;
end;
$function$;

-- fn_admin_set_withdrawals_enabled: fenced on p_site
CREATE OR REPLACE FUNCTION public.fn_admin_set_withdrawals_enabled(p_actor uuid, p_actor_role text, p_site uuid, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, p_site);   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.sites set withdrawals_enabled = p_enabled, updated_at = now() where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'withdrawals.toggle', 'site', p_site::text,
            jsonb_build_object('withdrawals_enabled', p_enabled), p_site);
  return p_enabled;
end;
$function$;

-- fn_admin_decide_advance: fenced on (select site_id from public.marketer_advance_requests where id = p_id)
CREATE OR REPLACE FUNCTION public.fn_admin_decide_advance(p_actor uuid, p_actor_role text, p_id uuid, p_approve boolean, p_note text)
 RETURNS marketer_advance_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_req public.marketer_advance_requests; v_exp public.marketer_expenses; v_note text;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.marketer_advance_requests where id = p_id));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  v_note := nullif(btrim(coalesce(p_note,'')), '');

  select * into v_req from public.marketer_advance_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_req.status <> 'requested' then raise exception 'INVALID_STATE'; end if;

  if p_approve then
    -- Log the advance as a marketer_expense (category 'advance') — nets the marketer's withdrawable.
    insert into public.marketer_expenses(site_id, marketer_user_id, category, amount_cents, note, created_by)
      values (v_req.site_id, v_req.marketer_user_id, 'advance', v_req.amount_cents,
              coalesce(v_note, v_req.reason, 'Advance request approved'), p_actor)
      returning * into v_exp;
    update public.marketer_advance_requests
       set status = 'approved', decided_by = p_actor, decided_at = now(),
           decision_note = v_note, expense_id = v_exp.id
     where id = p_id returning * into v_req;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'marketer.advance.approve', 'marketer_advance_requests', p_id::text,
              jsonb_build_object('amount_cents', v_req.amount_cents, 'expense_id', v_exp.id, 'note', v_note), v_req.site_id);
  else
    update public.marketer_advance_requests
       set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_id returning * into v_req;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'marketer.advance.reject', 'marketer_advance_requests', p_id::text,
              jsonb_build_object('amount_cents', v_req.amount_cents, 'reason', v_note), v_req.site_id);
  end if;
  return v_req;
end;
$function$;

-- fn_admin_set_site_owner: fenced on (select site_id from public.profiles where id = p_marketer)
CREATE OR REPLACE FUNCTION public.fn_admin_set_site_owner(p_actor uuid, p_actor_role text, p_marketer uuid, p_make_default boolean)
 RETURNS sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.sites; v_role text; v_status text; v_target_site uuid; v_site uuid;
        v_actor_site uuid; v_actor_role text;
begin
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_marketer));   -- Issue 1 / F-46: DB-level brand fence
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select role, status, site_id into v_role, v_status, v_target_site from public.profiles where id = p_marketer;
  if not found then raise exception 'OWNER_NOT_FOUND'; end if;

  if p_make_default then
    -- ── ASSIGN ── the target must be an ACTIVE marketer on their own brand.
    if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
    v_site := v_target_site;
    if not exists (select 1 from public.sites where id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
    if p_actor_role in ('admin','superadmin') then
      select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
      -- A platform-owner actor (even via an impersonation superadmin token) is cross-brand; the
      -- token-scoped API guard fences impersonation. Only a REAL per-brand admin is home-fenced here.
      if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
        raise exception 'SITE_SCOPE_FORBIDDEN';
      end if;
    end if;
    if v_status <> 'active' then raise exception 'OWNER_NOT_ACTIVE'; end if;
    update public.sites set owner_user_id = p_marketer, updated_at = now() where id = v_site returning * into v_row;
  else
    -- ── CLEAR ── remove this user as the default of whatever brand they currently own, regardless of
    --    their current role/status. Cleared brand derived from the ownership row itself.
    select id into v_site from public.sites where owner_user_id = p_marketer;
    if not found then
      v_site := v_target_site;
      if p_actor_role in ('admin','superadmin') then
        select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
        if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
          raise exception 'SITE_SCOPE_FORBIDDEN';
        end if;
      end if;
      select * into v_row from public.sites where id = v_site;
    else
      if p_actor_role in ('admin','superadmin') then
        select role, site_id into v_actor_role, v_actor_site from public.profiles where id = p_actor;
        if v_actor_role is distinct from 'platform_superadmin' and v_actor_site is distinct from v_site then
          raise exception 'SITE_SCOPE_FORBIDDEN';
        end if;
      end if;
      update public.sites set owner_user_id = null, updated_at = now() where id = v_site returning * into v_row;
    end if;
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'admin.set_site_owner', 'site', v_site::text,
            jsonb_build_object('owner_user_id', case when p_make_default then p_marketer else null end,
                               'marketer', p_marketer, 'make_default', p_make_default), v_site);
  return v_row;
end;
$function$;

-- ── Permission vs targeting for the six former fn_actor_target_sites callers ──

CREATE OR REPLACE FUNCTION public.fn_addon_brand_view(p_actor uuid, p_actor_role text, p_site uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_chart text; v_trade text;
begin
  if p_site not in (select site_id from public.fn_actor_scope_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  select chart_style, trade_ui into v_chart, v_trade from public.sites where id = p_site;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'category', c.category, 'key', c.key, 'display_name', c.display_name,
      'price_cents', c.price_cents, 'is_default', c.is_default,
      'entitled', (e.key is not null),
      'active', case when c.category = 'chart' then (c.key = v_chart)
                     when c.category = 'trade_ui' then (c.key = v_trade)
                     else (e.key is not null) end,
      'pending', (r.id is not null)
    ) order by c.category, c.sort_order, c.key), '[]'::jsonb)
    from public.addon_catalog c
    left join public.brand_entitlements e on e.site_id = p_site and e.category = c.category and e.key = c.key
    left join public.addon_requests r on r.site_id = p_site and r.category = c.category and r.key = c.key and r.status = 'requested'
    where c.active
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_addon_request(p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_price bigint; v_slug text; v_id bigint;
begin
  if p_site not in (select site_id from public.fn_actor_scope_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  select price_cents into v_price from public.addon_catalog where category = p_category and key = p_key and active;
  if v_price is null then raise exception 'ADDON_NOT_FOUND'; end if;
  if exists (select 1 from public.brand_entitlements where site_id = p_site and category = p_category and key = p_key) then
    raise exception 'ALREADY_ENTITLED';
  end if;
  select slug into v_slug from public.sites where id = p_site;
  insert into public.addon_requests(site_id, category, key, price_cents, requested_by, note)
    values (p_site, p_category, p_key, v_price, p_actor, nullif(btrim(coalesce(p_note,'')),''))
    on conflict (site_id, category, key) where status = 'requested' do update set price_cents = excluded.price_cents
    returning id into v_id;
  -- Notify the system admin(s).
  insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
    select pr.id, 'info', 'Add-on request',
           format('%s requested "%s" (%s) for brand %s.', p_actor_role, p_key, p_category, v_slug),
           true, 'addon_request', p_actor, p_site
      from public.profiles pr where pr.role = 'platform_superadmin' and pr.status = 'active';
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.request', 'site', p_site::text,
            jsonb_build_object('category', p_category, 'key', p_key, 'price_cents', v_price), p_site);
  return jsonb_build_object('id', v_id, 'site_id', p_site, 'category', p_category, 'key', p_key, 'price_cents', v_price, 'status', 'requested');
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_addon_list_requests(p_actor uuid, p_actor_role text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'site_id', r.site_id, 'slug', s.slug, 'name', s.name,
           'category', r.category, 'key', r.key, 'status', r.status, 'price_cents', r.price_cents,
           'note', r.note, 'requested_by', r.requested_by, 'created_at', r.created_at,
           'decided_by', r.decided_by, 'decided_at', r.decided_at
         ) order by r.created_at desc), '[]'::jsonb)
  from public.addon_requests r join public.sites s on s.id = r.site_id
  where r.site_id in (select site_id from public.fn_actor_scope_sites(p_actor, p_actor_role))
    and (p_status is null or r.status = p_status);
$function$;

CREATE OR REPLACE FUNCTION public.fn_notification_audience_scoped(p_actor uuid, p_actor_role text, p_audience jsonb)
 RETURNS TABLE(user_id uuid, site_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.site_id
  from public.profiles p
  where p.status = coalesce(nullif(p_audience->>'status',''), 'active')
    and p.role in ('player','marketer','admin','superadmin','super_admin','platform_superadmin')
    -- HARD tenant bound: the caller can never exceed its own sites.
    and p.site_id in (select fas.site_id from public.fn_actor_bulk_sites(p_actor, p_actor_role, p_audience) fas)
    -- optional explicit role filter
    and ( not (p_audience ? 'roles')
          or p.role in (select jsonb_array_elements_text(p_audience->'roles')) )
    -- optional brand/site filter (can only NARROW within the allowed sites above)
    and ( not (p_audience ? 'sites')
          or p.site_id in (select (jsonb_array_elements_text(p_audience->'sites'))::uuid) )
    -- optional "affected only": users with a FAILED payment of the given kind within the window
    and ( not (p_audience ? 'affected_within_hours')
          or p.id in (
            select t.user_id from public.transactions t
            where t.kind = coalesce(nullif(p_audience->>'affected_kind',''), 'deposit')
              and t.status = 'failed'
              and t.created_at > now() - (greatest((p_audience->>'affected_within_hours')::int, 0) * interval '1 hour')
          ) );
$function$;

CREATE OR REPLACE FUNCTION public.fn_broadcast_notification(p_actor uuid, p_actor_role text, p_template_key text, p_audience jsonb DEFAULT NULL::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tmpl public.notification_templates; v_aud jsonb; v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  select * into v_tmpl from public.notification_templates where key = p_template_key and active;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;

  v_aud := coalesce(p_audience, v_tmpl.default_audience, '{}'::jsonb);

  -- A "restored/complete" template clears the incident banners it supersedes first — but ONLY within
  -- the caller's own sites (a site admin must not clear another brand's banners).
  if v_tmpl.resolves_category is not null then
    update public.user_notifications set resolved_at = now()
      where category = v_tmpl.resolves_category
        and dismissed_at is null and resolved_at is null
        and site_id in (select fas.site_id from public.fn_actor_bulk_sites(p_actor, p_actor_role, v_aud) fas);
  end if;

  with ins as (
    insert into public.user_notifications
      (user_id, level, title, body, dismissible, category, created_by, site_id)
    select a.user_id, v_tmpl.level, v_tmpl.title, v_tmpl.body, v_tmpl.dismissible, v_tmpl.category, p_actor, a.site_id
    from public.fn_notification_audience_scoped(p_actor, p_actor_role, v_aud) a
    where not exists (
      select 1 from public.user_notifications n
      where n.user_id = a.user_id and n.category = v_tmpl.category
        and n.dismissed_at is null and n.resolved_at is null
    )
    returning 1
  )
  select count(*)::int into v_count from ins;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.broadcast', 'template', p_template_key,
            jsonb_build_object('recipients', v_count, 'category', v_tmpl.category,
                               'level', v_tmpl.level, 'audience', v_aud));
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_resolve_notifications_by_category(p_actor uuid, p_actor_role text, p_category text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.user_notifications set resolved_at = now()
    where category = p_category and dismissed_at is null and resolved_at is null
      and site_id in (select fas.site_id from public.fn_actor_target_sites(p_actor, p_actor_role) fas);
  get diagnostics v_count = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.resolve_category', 'category', p_category,
            jsonb_build_object('cleared', v_count));
  return v_count;
end;
$function$;

-- 4-arg overload: clears only p_site, and only when it is within the actor's PERMISSION set.
CREATE OR REPLACE FUNCTION public.fn_resolve_notifications_by_category(p_actor uuid, p_actor_role text, p_category text, p_site uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.user_notifications set resolved_at = now()
    where category = p_category and dismissed_at is null and resolved_at is null
      and site_id in (select fas.site_id from public.fn_actor_bulk_sites(p_actor, p_actor_role, jsonb_build_object('sites', jsonb_build_array(p_site))) fas);
  get diagnostics v_count = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.resolve_category', 'category', p_category,
            jsonb_build_object('cleared', v_count, 'site_id', p_site));
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ticket_create(p_actor uuid, p_actor_role text, p_platform uuid, p_site uuid, p_subject text, p_body text, p_urgency text)
 RETURNS tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.tickets; v_platform uuid; v_site uuid; v_level int; v_assignee text;
begin
  if p_actor_role not in ('admin','platform_admin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(btrim(p_subject),'') = '' then raise exception 'INVALID_SUBJECT'; end if;
  if p_urgency not in ('low','medium','high','critical') then raise exception 'INVALID_URGENCY'; end if;

  if p_actor_role = 'admin' then
    -- Issue 1 / F-46: the brand the session acts for — an explicit p_site within the actor's
    -- PERMISSION set (impersonation names the token's brand), else the GENUINE site admin's own brand.
    if p_site is not null then
      if not exists (select 1 from public.fn_actor_scope_sites(p_actor, p_actor_role) s where s.site_id = p_site) then
        raise exception 'SITE_SCOPE_FORBIDDEN';
      end if;
      v_site := p_site;
    else
      select site_id into v_site from public.profiles where id = p_actor and role = 'admin';
      if v_site is null then raise exception 'NOT_AUTHORIZED'; end if;
    end if;
    v_platform := (select platform_id from public.sites where id = v_site);
    v_level := 0;                                   -- -> assigned to the platform admin
  elsif p_actor_role = 'platform_admin' then
    select platform_id into v_platform from public.profiles where id = p_actor;
    if v_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    if p_site is not null then
      if (select platform_id from public.sites where id = p_site) is distinct from v_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
      v_site := p_site;
    end if;
    v_level := 1;                                   -- a platform admin escalates straight to the System admin
  else -- platform_superadmin
    if p_platform is null then raise exception 'INVALID_PLATFORM'; end if;
    if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
    v_platform := p_platform; v_site := p_site; v_level := 0;
  end if;

  v_assignee := case when v_level = 0 then 'platform_admin' else 'platform_superadmin' end;
  insert into public.tickets (platform_id, site_id, created_by, created_by_role, subject, body, urgency,
                              escalation_level, assignee_role, sla_due_at)
    values (v_platform, v_site, p_actor, p_actor_role, btrim(p_subject), coalesce(p_body,''), p_urgency,
            v_level, v_assignee, case when v_level=0 then public.fn_ticket_sla_due(p_urgency, now()) else null end)
    returning * into v_row;

  perform public.fn_ticket_notify(v_row.id, v_assignee,
    'New '||upper(p_urgency)||' ticket: '||btrim(p_subject),
    case p_urgency when 'critical' then 'error' when 'high' then 'warning' else 'info' end);
  return v_row;
end;
$function$;

-- ── Grants: SECURITY DEFINER helpers/RPCs are service_role-only (0151 posture) ──
revoke execute on function public.fn_actor_scope_sites(uuid, text) from anon, authenticated, public;
revoke execute on function public.fn_actor_target_sites(uuid, text) from anon, authenticated, public;
revoke execute on function public.fn_actor_bulk_sites(uuid, text, jsonb) from anon, authenticated, public;
revoke execute on function public.fn_assert_actor_site_scope(uuid, text, uuid) from anon, authenticated, public;
revoke execute on function public.fn_resolve_notifications_by_category(uuid, text, text, uuid) from anon, authenticated, public;
grant execute on function public.fn_actor_scope_sites(uuid, text), public.fn_actor_target_sites(uuid, text),
  public.fn_actor_bulk_sites(uuid, text, jsonb), public.fn_assert_actor_site_scope(uuid, text, uuid),
  public.fn_resolve_notifications_by_category(uuid, text, text, uuid) to service_role;
