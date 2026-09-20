-- 0150_mpesa_daraja_fields.sql — complete the Daraja config (Issue 2): Paybill/Till, till number,
-- separate B2C shortcode, and B2C CommandID.
--
-- daraja.ts hardcoded TransactionType=CustomerPayBillOnline, STK PartyB=shortcode, B2C
-- CommandID=BusinessPayment and B2C PartyA=shortcode. Real setups differ: a Till (Buy Goods) needs
-- CustomerBuyGoodsOnline + a till/store number for PartyB; B2C often uses a SEPARATE shortcode (PartyA)
-- and a different CommandID (Salary/Promotion). These become configurable, defaulting to the current
-- behaviour so existing paybill deployments are unchanged. Additive + idempotent.

alter table public.mpesa_config add column if not exists transaction_type text not null default 'paybill';
alter table public.mpesa_config add column if not exists till_number      text not null default '';
alter table public.mpesa_config add column if not exists b2c_shortcode     text not null default '';
alter table public.mpesa_config add column if not exists b2c_command_id    text not null default 'BusinessPayment';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'mpesa_config_txn_type_chk') then
    alter table public.mpesa_config add constraint mpesa_config_txn_type_chk check (transaction_type in ('paybill','till'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mpesa_config_b2c_cmd_chk') then
    alter table public.mpesa_config add constraint mpesa_config_b2c_cmd_chk check (b2c_command_id in ('BusinessPayment','SalaryPayment','PromotionPayment'));
  end if;
end $$;

-- Redefine the setter to patch (and return) the new fields. Body is a faithful copy of 0059 with the
-- 4 fields added to the validation, the UPDATE, and the RETURNS/return-query. The RETURNS TABLE gains
-- columns, so the old signature must be dropped first (CREATE OR REPLACE can't change return type).
drop function if exists public.fn_admin_update_mpesa_config(uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.fn_admin_update_mpesa_config(p_actor uuid, p_actor_role text, p_patch jsonb)
 RETURNS TABLE(environment text, shortcode text, stk_callback_url text, b2c_initiator text, b2c_result_url text, b2c_timeout_url text, has_consumer_key boolean, has_consumer_secret boolean, has_passkey boolean, has_security_credential boolean, transaction_type text, till_number text, b2c_shortcode text, b2c_command_id text, updated_by uuid, updated_at timestamp with time zone)
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
  if (p_patch ? 'transactionType') and (p_patch->>'transactionType') not in ('paybill','till') then
    raise exception 'INVALID_CONFIG';
  end if;
  if (p_patch ? 'b2cCommandId') and (p_patch->>'b2cCommandId') not in ('BusinessPayment','SalaryPayment','PromotionPayment') then
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
    transaction_type        = coalesce(p_patch->>'transactionType', mpesa_config.transaction_type),
    till_number             = coalesce(p_patch->>'tillNumber',      mpesa_config.till_number),
    b2c_shortcode           = coalesce(p_patch->>'b2cShortcode',    mpesa_config.b2c_shortcode),
    b2c_command_id          = coalesce(p_patch->>'b2cCommandId',    mpesa_config.b2c_command_id),
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
                                           'transactionType', v_before->>'transaction_type', 'b2cCommandId', v_before->>'b2c_command_id'),
              'after',  jsonb_build_object('environment', v_after.environment, 'shortcode', v_after.shortcode,
                                           'transactionType', v_after.transaction_type, 'b2cCommandId', v_after.b2c_command_id),
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
           v_after.transaction_type, v_after.till_number, v_after.b2c_shortcode, v_after.b2c_command_id,
           v_after.updated_by, v_after.updated_at;
end;
$function$
;
