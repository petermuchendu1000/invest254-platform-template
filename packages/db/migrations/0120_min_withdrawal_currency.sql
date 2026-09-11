-- 0120_min_withdrawal_currency.sql — currency-native minimum withdrawal (per-brand, docs/25 §16).
--
-- WHY: `site_game_config.min_withdrawal` is authoritative in KES cents (the money of record). For a
-- brand whose DISPLAY currency is not KES (sites.currency, e.g. USD), a fixed KES-cents minimum shows
-- as an odd converted figure (KES 2,000 ≈ $15) and can't express an operator intent like "min $100".
-- This adds a per-brand minimum expressed in the brand's DISPLAY currency; the API enforces it by
-- converting to KES cents at the SAME live FX rate the withdrawal amount uses, so the effective floor
-- is EXACTLY the native amount (drift-free) and KES brands are numerically unchanged (rate = 1).
--
-- Money-safe + additive: `min_withdrawal` (KES cents) stays as the authoritative fallback whenever the
-- native value is unset OR the FX rate is unavailable, so enforcement can never open below the KES floor.

alter table public.site_game_config
  add column if not exists min_withdrawal_native numeric
    check (min_withdrawal_native is null or min_withdrawal_native > 0);

comment on column public.site_game_config.min_withdrawal_native is
  'Minimum withdrawal in the brand DISPLAY currency major units (e.g. 100 => $100 for a USD brand, '
  '2000 => KES 2,000 for a KES brand). NULL => fall back to min_withdrawal (KES cents). Enforced by '
  'converting to KES cents at the live FX rate (docs/25 §16).';

-- Backfill KES brands from the existing KES-cents floor so behaviour is identical (2000.00 == KES 2,000).
update public.site_game_config sgc
   set min_withdrawal_native = round((sgc.min_withdrawal / 100.0)::numeric, 2)
  from public.sites s
 where s.id = sgc.site_id and coalesce(s.currency, 'KES') = 'KES'
   and sgc.min_withdrawal_native is null;

-- Extend the platform per-brand economy setter (0052) to accept `min_withdrawal_native` in its patch.
create or replace function public.fn_platform_set_site_config(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb
) returns public.site_game_config
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.site_game_config; v_before jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;
  if p_patch ? 'min_withdrawal_native'
     and (p_patch->>'min_withdrawal_native') is not null
     and (p_patch->>'min_withdrawal_native')::numeric <= 0 then
    raise exception 'INVALID_MIN_WITHDRAWAL_NATIVE';
  end if;

  update public.site_game_config u set
    house_edge            = case when p_patch ? 'house_edge'            then (p_patch->>'house_edge')::numeric            else u.house_edge end,
    max_multiplier        = case when p_patch ? 'max_multiplier'        then (p_patch->>'max_multiplier')::numeric        else u.max_multiplier end,
    min_stake             = case when p_patch ? 'min_stake'             then (p_patch->>'min_stake')::bigint             else u.min_stake end,
    max_stake             = case when p_patch ? 'max_stake'             then (p_patch->>'max_stake')::bigint             else u.max_stake end,
    min_withdrawal        = case when p_patch ? 'min_withdrawal'        then (p_patch->>'min_withdrawal')::bigint        else u.min_withdrawal end,
    min_withdrawal_native = case when p_patch ? 'min_withdrawal_native' then (p_patch->>'min_withdrawal_native')::numeric else u.min_withdrawal_native end,
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
$fn$;

-- Operator intent for the live USD brand: minimum withdrawal = $100 (not KES 2,000 ≈ $15).
update public.site_game_config sgc
   set min_withdrawal_native = 100
  from public.sites s
 where s.id = sgc.site_id and s.currency = 'USD';
