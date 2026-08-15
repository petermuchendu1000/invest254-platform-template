-- 0060_platform_site_mpesa_legal.sql — let the platform console edit per-brand M-Pesa (non-secret)
-- config + legal copy (docs/24 §13). Extends fn_platform_update_site to additionally patch the
-- sites.mpesa_env / mpesa_shortcode / mpesa_callback_base / mpesa_b2c_initiator columns and the
-- legal_copy jsonb. SECRET refs (consumer key/secret, passkey, B2C credential) are intentionally
-- NOT settable here — those are infra secrets. NOTE: live STK/B2C routing still uses the GLOBAL
-- mpesa_config until per-brand payment routing + secret-ref resolution ships (docs/22 Task B); this
-- migration only makes the per-brand config editable + stored. Bodies verbatim from live DB; only the
-- UPDATE SET is extended. Idempotent (CREATE OR REPLACE); grants preserved.

CREATE OR REPLACE FUNCTION public.fn_platform_update_site(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 RETURNS sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.sites; v_before jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(s) into v_before from public.sites s where s.id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;

  update public.sites u set
    name           = case when p_patch ? 'name'           then btrim(p_patch->>'name')          else u.name end,
    primary_domain = case when p_patch ? 'primary_domain' then nullif(btrim(p_patch->>'primary_domain'),'') else u.primary_domain end,
    logo_url       = case when p_patch ? 'logo_url'       then nullif(p_patch->>'logo_url','')  else u.logo_url end,
    favicon_url    = case when p_patch ? 'favicon_url'    then nullif(p_patch->>'favicon_url','') else u.favicon_url end,
    wordmark_text  = case when p_patch ? 'wordmark_text'  then nullif(p_patch->>'wordmark_text','') else u.wordmark_text end,
    color_primary  = case when p_patch ? 'color_primary'  then p_patch->>'color_primary'        else u.color_primary end,
    color_bg       = case when p_patch ? 'color_bg'       then p_patch->>'color_bg'             else u.color_bg end,
    color_accent   = case when p_patch ? 'color_accent'   then p_patch->>'color_accent'         else u.color_accent end,
    theme          = case when p_patch ? 'theme'          then p_patch->>'theme'                else u.theme end,
    currency       = case when p_patch ? 'currency'       then p_patch->>'currency'             else u.currency end,
    locale         = case when p_patch ? 'locale'         then p_patch->>'locale'               else u.locale end,
    licence_line   = case when p_patch ? 'licence_line'   then nullif(p_patch->>'licence_line','') else u.licence_line end,
    support_email  = case when p_patch ? 'support_email'  then nullif(p_patch->>'support_email','') else u.support_email end,
    status         = case when p_patch ? 'status'         then p_patch->>'status'               else u.status end,
    mpesa_env           = case when p_patch ? 'mpesa_env'            then nullif(p_patch->>'mpesa_env','')            else u.mpesa_env end,
    mpesa_shortcode     = case when p_patch ? 'mpesa_shortcode'      then nullif(p_patch->>'mpesa_shortcode','')      else u.mpesa_shortcode end,
    mpesa_callback_base = case when p_patch ? 'mpesa_callback_base'  then nullif(p_patch->>'mpesa_callback_base','')  else u.mpesa_callback_base end,
    mpesa_b2c_initiator = case when p_patch ? 'mpesa_b2c_initiator'  then nullif(p_patch->>'mpesa_b2c_initiator','')  else u.mpesa_b2c_initiator end,
    legal_copy          = case when p_patch ? 'legal_copy'           then p_patch->'legal_copy'                       else u.legal_copy end,
    updated_at     = now()
  where u.id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.update', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$
;
