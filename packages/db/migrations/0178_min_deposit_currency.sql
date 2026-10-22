-- 0178_min_deposit_currency.sql — currency-native minimum deposit (per-brand), mirror of 0120.
--
-- WHY: the minimum DEPOSIT was global only — the static `MIN_DEPOSIT_CENTS` (KES 200) plus an optional
-- platform GLOBAL enforce. A brand whose DISPLAY currency is not KES (sites.currency, e.g. USD) could
-- not express an operator intent like "min $1": the KES-cents floor round-trips through FX into an odd
-- figure (and a rounding bug in the player UI pushed a clean $5 floor to $6). This adds a per-brand
-- minimum expressed in the brand's DISPLAY currency; the API enforces it by converting to KES cents at
-- the SAME live FX rate the deposit amount uses, so the effective floor is EXACTLY the native amount
-- (drift-free). Unlike the withdrawal floor this may be BELOW the platform default — it IS the
-- operator's intended minimum. KES brands are numerically unchanged (rate = 1).
--
-- Money-safe + additive: the static `MIN_DEPOSIT_CENTS` (and any platform GLOBAL enforce) stays as the
-- authoritative fallback whenever the native value is unset OR the FX rate is unavailable.

alter table public.site_game_config
  add column if not exists min_deposit_native numeric
    check (min_deposit_native is null or min_deposit_native > 0);

comment on column public.site_game_config.min_deposit_native is
  'Minimum deposit in the brand DISPLAY currency major units (e.g. 1 => $1 for a USD brand, '
  '200 => KES 200 for a KES brand). NULL => fall back to the static MIN_DEPOSIT_CENTS (KES 200) / the '
  'platform GLOBAL enforce. Enforced by converting to KES cents at the live FX rate; may be below the '
  'platform default (it is the operator''s intended minimum).';

-- Backfill KES brands from the static default (KES 200) so behaviour is identical and the value is
-- explicit/editable in the admin console. Foreign brands stay NULL (fall back until an operator sets one).
update public.site_game_config sgc
   set min_deposit_native = 200
  from public.sites s
 where s.id = sgc.site_id and coalesce(s.currency, 'KES') = 'KES'
   and sgc.min_deposit_native is null;

-- Extend the platform per-brand economy setter to accept `min_deposit_native` in its patch. Rebuilt
-- from the CURRENT definition (0134 — platform-scoped authorization via fn_platform_site_in_scope,
-- which allows platform_admin within scope), NOT the older 0052/0120 superadmin-only body, so this
-- migration adds the new field without regressing the scoped-authorization behaviour.
create or replace function public.fn_platform_set_site_config(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 returns site_game_config language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.site_game_config; v_before jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site_id);
  if p_patch ? 'min_withdrawal_native'
     and (p_patch->>'min_withdrawal_native') is not null
     and (p_patch->>'min_withdrawal_native')::numeric <= 0 then
    raise exception 'INVALID_MIN_WITHDRAWAL_NATIVE';
  end if;
  if p_patch ? 'min_deposit_native'
     and (p_patch->>'min_deposit_native') is not null
     and (p_patch->>'min_deposit_native')::numeric <= 0 then
    raise exception 'INVALID_MIN_DEPOSIT_NATIVE';
  end if;

  update public.site_game_config u set
    house_edge            = case when p_patch ? 'house_edge'            then (p_patch->>'house_edge')::numeric            else u.house_edge end,
    max_multiplier        = case when p_patch ? 'max_multiplier'        then (p_patch->>'max_multiplier')::numeric        else u.max_multiplier end,
    min_stake             = case when p_patch ? 'min_stake'             then (p_patch->>'min_stake')::bigint             else u.min_stake end,
    max_stake             = case when p_patch ? 'max_stake'             then (p_patch->>'max_stake')::bigint             else u.max_stake end,
    min_withdrawal        = case when p_patch ? 'min_withdrawal'        then (p_patch->>'min_withdrawal')::bigint        else u.min_withdrawal end,
    min_withdrawal_native = case when p_patch ? 'min_withdrawal_native' then (p_patch->>'min_withdrawal_native')::numeric else u.min_withdrawal_native end,
    min_deposit_native    = case when p_patch ? 'min_deposit_native'    then (p_patch->>'min_deposit_native')::numeric    else u.min_deposit_native end,
    default_duration_s    = case when p_patch ? 'default_duration_s'    then (p_patch->>'default_duration_s')::int       else u.default_duration_s end,
    tick_rate_ms          = case when p_patch ? 'tick_rate_ms'          then (p_patch->>'tick_rate_ms')::int             else u.tick_rate_ms end,
    drift_bias            = case when p_patch ? 'drift_bias'            then (p_patch->>'drift_bias')::numeric           else u.drift_bias end,
    volatility            = case when p_patch ? 'volatility'            then (p_patch->>'volatility')::numeric           else u.volatility end,
    target_win_rate       = case when p_patch ? 'target_win_rate'       then (p_patch->>'target_win_rate')::numeric      else u.target_win_rate end,
    version               = u.version + 1,
    updated_by            = p_actor,
    updated_at            = now()
  where u.site_id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.config', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$;
