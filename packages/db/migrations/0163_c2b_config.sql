-- 0163_c2b_config.sql — PAY-2 (docs/45): C2B (customer-initiated Pay Bill / Till) configuration.
--
-- The manual "Lipa na M-PESA · Pay Bill" rail (0115) stores every C2B confirmation Safaricom pushes and lets
-- players claim it, but nothing let the System owner (a) edit what players are told to pay into
-- (paybill_config was seed-only), or (b) register the Confirmation / Validation URLs with Safaricom — the step
-- without which no C2B confirmation ever arrives. This adds the C2B URL settings and a record of the last
-- registration to the paybill_config singleton, owner-only RPCs to read/update them (audited), and a
-- recorder the API calls after it has called Daraja's C2B RegisterURL.
--
-- Safaricom rules enforced here: URLs must be public https; C2B URLs must not contain the words
-- M-PESA / MPESA / Safaricom / exec / exe / cmd / sql / query (Daraja rejects them); ResponseType is
-- 'Completed' or 'Cancelled' (what happens when the validation URL is unreachable). Additive + idempotent.

alter table public.paybill_config add column if not exists confirmation_url            text not null default '';
alter table public.paybill_config add column if not exists validation_url              text not null default '';
alter table public.paybill_config add column if not exists response_type               text not null default 'Completed';
alter table public.paybill_config add column if not exists registered_at               timestamptz;
alter table public.paybill_config add column if not exists registered_shortcode        text;
alter table public.paybill_config add column if not exists registered_confirmation_url text;
alter table public.paybill_config add column if not exists last_register_at            timestamptz;
alter table public.paybill_config add column if not exists last_register_ok            boolean;
alter table public.paybill_config add column if not exists last_register_message       text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'paybill_config_response_type_chk') then
    alter table public.paybill_config add constraint paybill_config_response_type_chk check (response_type in ('Completed','Cancelled'));
  end if;
end $$;

-- A C2B URL is acceptable to Daraja: https, no forbidden keywords. Empty = not set.
create or replace function public.fn_c2b_url_ok(p_url text)
returns boolean language sql immutable set search_path = public
as $$
  select p_url = ''
      or (p_url ~* '^https://[a-z0-9.-]+(:[0-9]+)?(/[^ ]*)?$'
          and p_url !~* '(m-?pesa|safaricom|exec|\.exe|cmd|sql|query)');
$$;

-- ── Read (owner tier) ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_admin_get_c2b_config(p_actor uuid, p_actor_role text)
returns table(enabled boolean, shortcode text, account_number text, business_name text, instructions text,
              confirmation_url text, validation_url text, response_type text,
              registered_at timestamptz, registered_shortcode text, registered_confirmation_url text,
              last_register_at timestamptz, last_register_ok boolean, last_register_message text,
              received_7d int, unclaimed int, last_received_at timestamptz, updated_by uuid, updated_at timestamptz)
language plpgsql stable security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select c.enabled, c.shortcode, c.account_number, c.business_name, c.instructions,
           c.confirmation_url, c.validation_url, c.response_type,
           c.registered_at, c.registered_shortcode, c.registered_confirmation_url,
           c.last_register_at, c.last_register_ok, c.last_register_message,
           (select count(*)::int from public.c2b_payments p where p.received_at > now() - interval '7 days'),
           (select count(*)::int from public.c2b_payments p where p.claimed_tx_id is null),
           (select max(p.received_at) from public.c2b_payments p),
           c.updated_by, c.updated_at
      from public.paybill_config c where c.id = 1;
end;
$fn$;

-- ── Update (owner tier, audited). Patch keys: enabled, shortcode, accountNumber, businessName,
--    instructions, confirmationUrl, validationUrl, responseType. ────────────────────────────────────
create or replace function public.fn_admin_update_c2b_config(p_actor uuid, p_actor_role text, p_patch jsonb)
returns void
language plpgsql security definer set search_path = public
as $fn$
declare v_before jsonb; v_after jsonb;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_CONFIG'; end if;
  if (p_patch ? 'enabled') and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'INVALID_CONFIG'; end if;
  if (p_patch ? 'shortcode') and btrim(p_patch->>'shortcode') !~ '^[0-9]{5,7}$' then raise exception 'INVALID_SHORTCODE'; end if;
  if (p_patch ? 'accountNumber') and length(btrim(p_patch->>'accountNumber')) > 20 then raise exception 'INVALID_ACCOUNT_NUMBER'; end if;
  if (p_patch ? 'businessName') and length(btrim(p_patch->>'businessName')) > 60 then raise exception 'INVALID_BUSINESS_NAME'; end if;
  if (p_patch ? 'instructions') and length(btrim(p_patch->>'instructions')) > 500 then raise exception 'INVALID_INSTRUCTIONS'; end if;
  if (p_patch ? 'confirmationUrl') and not public.fn_c2b_url_ok(btrim(p_patch->>'confirmationUrl')) then raise exception 'INVALID_C2B_URL'; end if;
  if (p_patch ? 'validationUrl') and not public.fn_c2b_url_ok(btrim(p_patch->>'validationUrl')) then raise exception 'INVALID_C2B_URL'; end if;
  if (p_patch ? 'responseType') and (p_patch->>'responseType') not in ('Completed','Cancelled') then raise exception 'INVALID_CONFIG'; end if;

  select to_jsonb(c) into v_before from public.paybill_config c where id = 1 for update;
  if v_before is null then raise exception 'NOT_FOUND'; end if;
  update public.paybill_config set
    enabled          = coalesce((p_patch->>'enabled')::boolean,      paybill_config.enabled),
    shortcode        = coalesce(btrim(p_patch->>'shortcode'),         paybill_config.shortcode),
    account_number   = coalesce(btrim(p_patch->>'accountNumber'),     paybill_config.account_number),
    business_name    = coalesce(btrim(p_patch->>'businessName'),      paybill_config.business_name),
    instructions     = coalesce(btrim(p_patch->>'instructions'),      paybill_config.instructions),
    confirmation_url = coalesce(btrim(p_patch->>'confirmationUrl'),   paybill_config.confirmation_url),
    validation_url   = coalesce(btrim(p_patch->>'validationUrl'),     paybill_config.validation_url),
    response_type    = coalesce(p_patch->>'responseType',             paybill_config.response_type),
    updated_by       = p_actor
  where id = 1;
  select to_jsonb(c) into v_after from public.paybill_config c where id = 1;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'c2b.config', 'paybill_config', '1', jsonb_build_object(
      'before', v_before - 'updated_at' - 'updated_by' - 'last_register_message',
      'after',  v_after  - 'updated_at' - 'updated_by' - 'last_register_message'));
end;
$fn$;

-- ── Record a RegisterURL attempt (the API calls Daraja, then records the outcome here) ─────────────
create or replace function public.fn_admin_record_c2b_registration(
  p_actor uuid, p_actor_role text, p_shortcode text, p_confirmation_url text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  update public.paybill_config set
    last_register_at      = now(),
    last_register_ok      = p_ok,
    last_register_message = left(coalesce(p_message, ''), 500),
    registered_at               = case when p_ok then now() else registered_at end,
    registered_shortcode        = case when p_ok then p_shortcode else registered_shortcode end,
    registered_confirmation_url = case when p_ok then p_confirmation_url else registered_confirmation_url end
  where id = 1;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'c2b.register_urls', 'paybill_config', '1',
            jsonb_build_object('ok', p_ok, 'shortcode', p_shortcode, 'confirmationUrl', p_confirmation_url, 'message', left(coalesce(p_message, ''), 200)));
end;
$fn$;

revoke all on function public.fn_c2b_url_ok(text) from public, anon, authenticated;
revoke all on function public.fn_admin_get_c2b_config(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_admin_update_c2b_config(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fn_admin_record_c2b_registration(uuid, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_c2b_url_ok(text) to service_role;
grant execute on function public.fn_admin_get_c2b_config(uuid, text) to service_role;
grant execute on function public.fn_admin_update_c2b_config(uuid, text, jsonb) to service_role;
grant execute on function public.fn_admin_record_c2b_registration(uuid, text, text, text, boolean, text) to service_role;
