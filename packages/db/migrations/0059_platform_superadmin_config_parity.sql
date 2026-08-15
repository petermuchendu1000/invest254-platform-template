-- 0059_platform_superadmin_config_parity.sql — finish governance parity for platform_superadmin.
--
-- 0058 fixed the user/status/balance/commission RPCs, but MISSED the four config/fairness RPCs that
-- back the owner-only Governance pages. They still hardcoded 'superadmin' as the sole actor, so a
-- platform_superadmin (the actual system owner) got NOT_AUTHORIZED when saving Game config, editing
-- M-Pesa config, reading M-Pesa config, or rotating a fairness seed. This admits platform_superadmin
-- (top of ROLE_RANK, superset of superadmin) as an actor on all four. Bodies copied verbatim from the
-- live DB; only the actor guard changed. Idempotent (CREATE OR REPLACE); grants preserved.
--   • fn_admin_update_game_config  : <> 'superadmin'            -> not in ('superadmin','platform_superadmin')
--   • fn_admin_update_mpesa_config : <> 'superadmin'            -> not in ('superadmin','platform_superadmin')
--   • fn_admin_rotate_seed         : <> 'superadmin'            -> not in ('superadmin','platform_superadmin')
--   • fn_admin_get_mpesa_config    : not in ('admin','superadmin') -> + 'platform_superadmin'
-- Day-to-day 'admin' remains excluded from game/mpesa/seed governance (owner-tier only), unchanged.
-- NOTE: also fixes a latent PL/pgSQL variable/column ambiguity in fn_admin_rotate_seed
-- (OUT param trade_date shadowed the ON CONFLICT column) via #variable_conflict use_column.

-- ── fn_admin_update_game_config ──
CREATE OR REPLACE FUNCTION public.fn_admin_update_game_config(p_actor uuid, p_actor_role text, p_patch jsonb)
 RETURNS TABLE(house_edge numeric, max_multiplier numeric, min_stake bigint, max_stake bigint, min_withdrawal bigint, default_duration_s integer, tick_rate_ms integer, drift_bias numeric, volatility numeric, target_win_rate numeric, version bigint, updated_by uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_before jsonb; v_after public.game_config%rowtype;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_CONFIG'; end if;
  select to_jsonb(g) into v_before from public.game_config g where id = 1 for update;
  if v_before is null then raise exception 'NOT_FOUND'; end if;
  begin
    update public.game_config set
      house_edge         = coalesce((p_patch->>'houseEdge')::numeric,          game_config.house_edge),
      max_multiplier     = coalesce((p_patch->>'maxMultiplier')::numeric,      game_config.max_multiplier),
      min_stake          = coalesce((p_patch->>'minStakeCents')::bigint,       game_config.min_stake),
      max_stake          = coalesce((p_patch->>'maxStakeCents')::bigint,       game_config.max_stake),
      min_withdrawal     = coalesce((p_patch->>'minWithdrawalCents')::bigint,  game_config.min_withdrawal),
      default_duration_s = coalesce((p_patch->>'defaultDurationS')::int,       game_config.default_duration_s),
      tick_rate_ms       = coalesce((p_patch->>'tickRateMs')::int,             game_config.tick_rate_ms),
      drift_bias         = coalesce((p_patch->>'driftBias')::numeric,          game_config.drift_bias),
      volatility         = coalesce((p_patch->>'volatility')::numeric,         game_config.volatility),
      target_win_rate    = coalesce((p_patch->>'targetWinRate')::numeric,      game_config.target_win_rate),
      updated_by         = p_actor
    where id = 1
    returning * into v_after;
  exception
    when check_violation then raise exception 'INVALID_CONFIG';
    when invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_CONFIG';
    when division_by_zero then raise exception 'INVALID_CONFIG';
  end;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'game.config', 'game_config', '1',
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_after)));
  return query select v_after.house_edge, v_after.max_multiplier, v_after.min_stake, v_after.max_stake,
                      v_after.min_withdrawal, v_after.default_duration_s, v_after.tick_rate_ms, v_after.drift_bias,
                      v_after.volatility, v_after.target_win_rate, v_after.version, v_after.updated_by, v_after.updated_at;
end;
$function$
;

-- ── fn_admin_update_mpesa_config ──
CREATE OR REPLACE FUNCTION public.fn_admin_update_mpesa_config(p_actor uuid, p_actor_role text, p_patch jsonb)
 RETURNS TABLE(environment text, shortcode text, stk_callback_url text, b2c_initiator text, b2c_result_url text, b2c_timeout_url text, has_consumer_key boolean, has_consumer_secret boolean, has_passkey boolean, has_security_credential boolean, updated_by uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_before jsonb; v_after public.mpesa_config%rowtype;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_CONFIG'; end if;
  if (p_patch ? 'environment') and (p_patch->>'environment') not in ('sandbox','production') then
    raise exception 'INVALID_CONFIG';
  end if;
  select to_jsonb(m) into v_before from public.mpesa_config m where id = 1 for update;
  if v_before is null then raise exception 'NOT_FOUND'; end if;

  update public.mpesa_config set
    environment             = coalesce(p_patch->>'environment',    mpesa_config.environment),
    shortcode               = coalesce(p_patch->>'shortcode',      mpesa_config.shortcode),
    stk_callback_url        = coalesce(p_patch->>'stkCallbackUrl', mpesa_config.stk_callback_url),
    b2c_initiator           = coalesce(p_patch->>'b2cInitiator',   mpesa_config.b2c_initiator),
    b2c_result_url          = coalesce(p_patch->>'b2cResultUrl',   mpesa_config.b2c_result_url),
    b2c_timeout_url         = coalesce(p_patch->>'b2cTimeoutUrl',  mpesa_config.b2c_timeout_url),
    -- secrets: only overwrite when a non-empty value is supplied
    consumer_key            = case when coalesce(p_patch->>'consumerKey','') <> ''        then p_patch->>'consumerKey'        else mpesa_config.consumer_key end,
    consumer_secret         = case when coalesce(p_patch->>'consumerSecret','') <> ''     then p_patch->>'consumerSecret'     else mpesa_config.consumer_secret end,
    passkey                 = case when coalesce(p_patch->>'passkey','') <> ''            then p_patch->>'passkey'            else mpesa_config.passkey end,
    b2c_security_credential = case when coalesce(p_patch->>'securityCredential','') <> '' then p_patch->>'securityCredential' else mpesa_config.b2c_security_credential end,
    updated_by              = p_actor
  where id = 1
  returning * into v_after;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'mpesa.config', 'mpesa_config', '1',
            jsonb_build_object(
              'before', jsonb_build_object('environment', v_before->>'environment', 'shortcode', v_before->>'shortcode',
                                           'stkCallbackUrl', v_before->>'stk_callback_url', 'b2cInitiator', v_before->>'b2c_initiator',
                                           'b2cResultUrl', v_before->>'b2c_result_url', 'b2cTimeoutUrl', v_before->>'b2c_timeout_url'),
              'after',  jsonb_build_object('environment', v_after.environment, 'shortcode', v_after.shortcode,
                                           'stkCallbackUrl', v_after.stk_callback_url, 'b2cInitiator', v_after.b2c_initiator,
                                           'b2cResultUrl', v_after.b2c_result_url, 'b2cTimeoutUrl', v_after.b2c_timeout_url),
              'secretsRotated', jsonb_build_object(
                'consumerKey',        coalesce(p_patch->>'consumerKey','') <> '',
                'consumerSecret',     coalesce(p_patch->>'consumerSecret','') <> '',
                'passkey',            coalesce(p_patch->>'passkey','') <> '',
                'securityCredential', coalesce(p_patch->>'securityCredential','') <> '')));

  return query
    select v_after.environment, v_after.shortcode, v_after.stk_callback_url, v_after.b2c_initiator,
           v_after.b2c_result_url, v_after.b2c_timeout_url,
           (v_after.consumer_key <> ''),            (v_after.consumer_secret <> ''),
           (v_after.passkey <> ''),                 (v_after.b2c_security_credential <> ''),
           v_after.updated_by, v_after.updated_at;
end;
$function$
;

-- ── fn_admin_get_mpesa_config ──
CREATE OR REPLACE FUNCTION public.fn_admin_get_mpesa_config(p_actor_role text)
 RETURNS TABLE(environment text, shortcode text, stk_callback_url text, b2c_initiator text, b2c_result_url text, b2c_timeout_url text, has_consumer_key boolean, has_consumer_secret boolean, has_passkey boolean, has_security_credential boolean, updated_by uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ begin if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if; return query select m.environment, m.shortcode, m.stk_callback_url, m.b2c_initiator, m.b2c_result_url, m.b2c_timeout_url, (m.consumer_key <> '') as has_consumer_key, (m.consumer_secret <> '') as has_consumer_secret, (m.passkey <> '') as has_passkey, (m.b2c_security_credential <> '') as has_security_credential, m.updated_by, m.updated_at from public.mpesa_config m where m.id = 1; end; $function$
;

-- ── fn_admin_rotate_seed ──
CREATE OR REPLACE FUNCTION public.fn_admin_rotate_seed(p_actor uuid, p_actor_role text, p_date date)
 RETURNS TABLE(trade_date date, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_version int; v_revealed timestamptz;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_date < current_date then raise exception 'PAST_DATE'; end if;
  select gd.revealed_at into v_revealed from public.game_days gd where gd.trade_date = p_date;
  if v_revealed is not null then raise exception 'SEED_REVEALED'; end if;
  insert into public.seed_overrides(trade_date, version, requested_by, updated_at)
    values (p_date, 1, p_actor, now())
    on conflict (trade_date) do update set version = public.seed_overrides.version + 1,
                                           requested_by = p_actor, updated_at = now()
    returning public.seed_overrides.version into v_version;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'game.seed_rotate', 'game_day', p_date::text,
            jsonb_build_object('trade_date', p_date, 'version', v_version));
  return query select p_date, v_version;
end;
$function$
;
