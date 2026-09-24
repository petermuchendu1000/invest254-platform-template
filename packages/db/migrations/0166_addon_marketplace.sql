-- 0166_addon_marketplace.sql — ADDON-1 (docs/48): a real add-ons marketplace.
--
-- Owner request (2026-09-23): "a complete overhaul of the /addons page … the current one looks like a total joke,
-- from UI, configs, implementations". What was missing / wrong (0144–0146):
--   * The catalog was a name and a price. No description, no pricing model on screen (0165 added billing_type /
--     setup_fee_cents but nothing could edit them), no way to hide an add-on, no adoption numbers.
--   * Deciding a request OVERWROTE the requester's note with the owner's note (the brand's reason was lost).
--   * A requester could not withdraw a request; a brand that owned two chart systems could not switch between
--     them (only the owner could, by re-granting).
--   * The price a brand was quoted at request time was not what it was charged if the owner changed the price
--     before approving (0165's trigger read the catalog at grant time).
--   * Notifications named keys ("area (chart)") instead of products.
-- This migration: catalog fields + an owner update RPC; requests keep the requester's note, snapshot the
-- pricing model and setup fee, get a decision note, can be cancelled; brands activate owned systems; the charge
-- honours the quoted price; richer scoped reads (catalog with adoption, brand view, requests, brand matrix).
-- Service-role only, audited. Additive + idempotent.

-- ── 1. Catalog: descriptions ──────────────────────────────────────────────────────────────────────
alter table public.addon_catalog add column if not exists description text not null default '';
update public.addon_catalog set description = d.txt from (values
  ('chart','line','The classic live price line. Clean and fast on any phone.'),
  ('chart','area','A filled area under the price line — easier to read at a glance, feels premium.'),
  ('chart','candlestick','TradingView candlesticks with timeframes, zoom and indicators, for traders who expect a real terminal.'),
  ('chart','bars','OHLC bars on the TradingView engine: open, high, low and close for every interval.'),
  ('chart','baseline','Price above and below a baseline in two colours, so moves stand out instantly.'),
  ('trade_ui','classic','The rise/fall trading screen with the live curve.'),
  ('trade_ui','digits','A Deriv-style digits broker screen: even/odd, over/under and matches/differs contracts.'),
  ('payment_gateway','mpesa','M-Pesa STK push deposits and B2C payouts through Safaricom Daraja.'),
  ('payment_gateway','megapay','Mega Pay deposits as an extra rail beside M-Pesa.'),
  ('payment_gateway','paystack','Paystack card and mobile-money deposits.'),
  ('payment_gateway','binance','Binance Pay crypto deposits.'),
  ('payment_gateway','stripe','Stripe card deposits for international players.')
) as d(cat, k, txt)
where addon_catalog.category = d.cat and addon_catalog.key = d.k and addon_catalog.description = '';

-- ── 2. Requests: keep the requester's note, snapshot the pricing, record the decision ──────────────
alter table public.addon_requests add column if not exists billing_type    text;
alter table public.addon_requests add column if not exists setup_fee_cents bigint not null default 0;
alter table public.addon_requests add column if not exists decision_note   text;
update public.addon_requests r set billing_type = c.billing_type
  from public.addon_catalog c where c.category = r.category and c.key = r.key and r.billing_type is null;

-- ── 3. Catalog read: owner sees everything (+ adoption); operators see what is offered ─────────────
create or replace function public.fn_addon_catalog_list(p_actor_role text)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'category', c.category, 'key', c.key, 'display_name', c.display_name, 'description', c.description,
           'price_cents', c.price_cents, 'billing_type', c.billing_type, 'setup_fee_cents', c.setup_fee_cents,
           'is_default', c.is_default, 'active', c.active, 'sort_order', c.sort_order, 'updated_at', c.updated_at,
           'brands', case when p_actor_role = 'platform_superadmin' then
                       (select count(*) from public.brand_entitlements e join public.sites s on s.id = e.site_id and s.status <> 'archived'
                         where e.category = c.category and e.key = c.key) end,
           'in_use', case when p_actor_role = 'platform_superadmin' then
                       (select count(*) from public.sites s where s.status <> 'archived'
                          and ((c.category = 'chart' and s.chart_style = c.key) or (c.category = 'trade_ui' and s.trade_ui = c.key))) end,
           'pending', case when p_actor_role = 'platform_superadmin' then
                       (select count(*) from public.addon_requests r where r.category = c.category and r.key = c.key and r.status = 'requested') end
         ) order by c.category, c.sort_order, c.key), '[]'::jsonb)
  from public.addon_catalog c
  where p_actor_role in ('admin','superadmin','platform_admin','platform_superadmin')
    and (c.active or p_actor_role = 'platform_superadmin');
$fn$;

-- ── 4. Owner: edit a catalog item (name, description, pricing model, price, setup fee, offered, order) ──
create or replace function public.fn_addon_update(p_actor uuid, p_actor_role text, p_category text, p_key text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.addon_catalog; v_type text; v_price bigint; v_setup bigint; v_active boolean; v_name text;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select * into v from public.addon_catalog where category = p_category and key = p_key for update;
  if not found then raise exception 'ADDON_NOT_FOUND'; end if;
  v_type  := coalesce(p_patch->>'billingType', v.billing_type);
  v_price := coalesce((p_patch->>'priceCents')::bigint, v.price_cents);
  v_setup := coalesce((p_patch->>'setupFeeCents')::bigint, v.setup_fee_cents);
  v_active := coalesce((p_patch->>'active')::boolean, v.active);
  v_name := coalesce(nullif(btrim(p_patch->>'displayName'), ''), v.display_name);
  if v_type not in ('free','one_off','monthly') then raise exception 'INVALID_BILLING_TYPE'; end if;
  if v_price < 0 or v_setup < 0 or v_price > 100000000000 or v_setup > 100000000000 then raise exception 'INVALID_AMOUNT'; end if;
  if length(v_name) > 60 then raise exception 'INVALID_NAME'; end if;
  if length(coalesce(p_patch->>'description', v.description)) > 400 then raise exception 'INVALID_DESCRIPTION'; end if;
  -- Free means free: no price, no setup fee. A paid model needs a price.
  if v_type = 'free' and (v_price <> 0 or v_setup <> 0) then raise exception 'FREE_HAS_PRICE'; end if;
  if v_type <> 'free' and v_price = 0 then raise exception 'PRICE_REQUIRED'; end if;
  -- The free default of a category is what every brand falls back to: always free, always offered.
  if v.is_default and (v_type <> 'free' or not v_active) then raise exception 'DEFAULT_MUST_BE_FREE'; end if;
  update public.addon_catalog set
    display_name = v_name,
    description = coalesce(btrim(p_patch->>'description'), description),
    billing_type = v_type, price_cents = v_price, setup_fee_cents = v_setup, active = v_active,
    sort_order = coalesce((p_patch->>'sortOrder')::int, sort_order),
    updated_by = p_actor, updated_at = now()
  where category = p_category and key = p_key returning * into v;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'addon.update', 'addon', p_category || ':' || p_key, p_patch);
  perform pg_notify('addon_catalog_changed', p_category || ':' || p_key);
  return jsonb_build_object('category', v.category, 'key', v.key, 'billing_type', v.billing_type, 'price_cents', v.price_cents,
                            'setup_fee_cents', v.setup_fee_cents, 'active', v.active);
end;
$fn$;

-- The legacy price setter keeps working, and keeps the pricing model consistent (a price on a free item makes it one-off).
create or replace function public.fn_addon_set_price(p_actor uuid, p_actor_role text, p_category text, p_key text, p_price_cents bigint)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_type text;
begin
  if p_price_cents is null or p_price_cents < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select case when p_price_cents = 0 then 'free' when billing_type = 'free' then 'one_off' else billing_type end
    into v_type from public.addon_catalog where category = p_category and key = p_key;
  return public.fn_addon_update(p_actor, p_actor_role, p_category, p_key,
    jsonb_build_object('priceCents', p_price_cents, 'billingType', coalesce(v_type, 'one_off'))
      || case when p_price_cents = 0 then '{"setupFeeCents":0}'::jsonb else '{}'::jsonb end);
end;
$fn$;

-- ── 5. Brand view: the marketplace for one brand ────────────────────────────────────────────────────
create or replace function public.fn_addon_brand_view(p_actor uuid, p_actor_role text, p_site uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_chart text; v_trade text;
begin
  if p_site not in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  select chart_style, trade_ui into v_chart, v_trade from public.sites where id = p_site;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'category', c.category, 'key', c.key, 'display_name', c.display_name, 'description', c.description,
      'price_cents', c.price_cents, 'billing_type', c.billing_type, 'setup_fee_cents', c.setup_fee_cents,
      'is_default', c.is_default, 'offered', c.active,
      'entitled', (e.key is not null), 'granted_at', e.granted_at,
      'active', case when c.category = 'chart' then (c.key = v_chart)
                     when c.category = 'trade_ui' then (c.key = v_trade)
                     else (e.key is not null) end,
      'pending', (r.id is not null), 'request_id', r.id, 'requested_at', r.created_at, 'request_note', r.note
    ) order by c.category, c.sort_order, c.key), '[]'::jsonb)
    from public.addon_catalog c
    left join public.brand_entitlements e on e.site_id = p_site and e.category = c.category and e.key = c.key
    left join public.addon_requests r on r.site_id = p_site and r.category = c.category and r.key = c.key and r.status = 'requested'
    -- hidden add-ons still show for a brand that owns one (it keeps what it has)
    where c.active or e.key is not null
  );
end;
$fn$;

-- ── 6. Request: snapshot the full quote; notify with product names ─────────────────────────────────
create or replace function public.fn_addon_request(
  p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare c public.addon_catalog; v_site record; v_id bigint; v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if p_site not in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  select * into c from public.addon_catalog where category = p_category and key = p_key and active;
  if not found then raise exception 'ADDON_NOT_FOUND'; end if;
  if exists (select 1 from public.brand_entitlements where site_id = p_site and category = p_category and key = p_key) then
    raise exception 'ALREADY_ENTITLED';
  end if;
  if length(coalesce(v_note, '')) > 500 then raise exception 'NOTE_TOO_LONG'; end if;
  select s.slug, s.name, p.name as platform into v_site from public.sites s left join public.platforms p on p.id = s.platform_id where s.id = p_site;
  insert into public.addon_requests(site_id, category, key, price_cents, billing_type, setup_fee_cents, requested_by, note)
    values (p_site, p_category, p_key, c.price_cents, c.billing_type, c.setup_fee_cents, p_actor, v_note)
    on conflict (site_id, category, key) where status = 'requested' do update
      set price_cents = excluded.price_cents, billing_type = excluded.billing_type, setup_fee_cents = excluded.setup_fee_cents,
          note = coalesce(excluded.note, addon_requests.note)
    returning id into v_id;
  insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
    select pr.id, 'info', left('Add-on request: ' || c.display_name, 120),
           left(format('%s (%s) asked for %s.%s', v_site.name, coalesce(v_site.platform, 'no platform'), c.display_name,
                       coalesce(' "' || v_note || '"', '')), 1000),
           true, 'addon_request', p_actor, p_site
      from public.profiles pr where pr.role = 'platform_superadmin' and pr.status = 'active';
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.request', 'site', p_site::text,
            jsonb_build_object('category', p_category, 'key', p_key, 'price_cents', c.price_cents, 'billing_type', c.billing_type,
                               'setup_fee_cents', c.setup_fee_cents), p_site);
  return jsonb_build_object('id', v_id, 'site_id', p_site, 'category', p_category, 'key', p_key, 'price_cents', c.price_cents,
                            'billing_type', c.billing_type, 'setup_fee_cents', c.setup_fee_cents, 'status', 'requested');
end;
$fn$;

-- ── 7. Cancel a request (whoever may request for that brand) ───────────────────────────────────────
create or replace function public.fn_addon_cancel_request(p_actor uuid, p_actor_role text, p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare r public.addon_requests;
begin
  select * into r from public.addon_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.site_id not in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  if r.status <> 'requested' then raise exception 'REQUEST_NOT_OPEN'; end if;
  update public.addon_requests set status = 'cancelled', decided_by = p_actor, decided_at = now() where id = r.id;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.request.cancel', 'site', r.site_id::text,
            jsonb_build_object('category', r.category, 'key', r.key, 'request_id', r.id), r.site_id);
  return jsonb_build_object('id', r.id, 'status', 'cancelled');
end;
$fn$;

-- ── 8. Requests list: product names, pricing snapshot, platform, requester, both notes ─────────────
create or replace function public.fn_addon_list_requests(p_actor uuid, p_actor_role text, p_status text default null)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'site_id', r.site_id, 'slug', s.slug, 'name', s.name, 'platform_id', s.platform_id, 'platform_name', p.name,
           'category', r.category, 'key', r.key, 'display_name', coalesce(c.display_name, r.key), 'status', r.status,
           'price_cents', r.price_cents, 'billing_type', coalesce(r.billing_type, c.billing_type, 'one_off'), 'setup_fee_cents', r.setup_fee_cents,
           'note', r.note, 'decision_note', r.decision_note,
           'requested_by', r.requested_by, 'requested_by_name', rq.username, 'created_at', r.created_at,
           'decided_by', r.decided_by, 'decided_by_name', dq.username, 'decided_at', r.decided_at
         ) order by (r.status = 'requested') desc, r.created_at desc), '[]'::jsonb)
  from public.addon_requests r
  join public.sites s on s.id = r.site_id
  left join public.platforms p on p.id = s.platform_id
  left join public.addon_catalog c on c.category = r.category and c.key = r.key
  left join public.profiles rq on rq.id = r.requested_by
  left join public.profiles dq on dq.id = r.decided_by
  where r.site_id in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role))
    and (p_status is null or r.status = p_status);
$fn$;

-- ── 9. Decide: keep the requester's note; store the owner's; say what is billed ────────────────────
create or replace function public.fn_addon_decide_request(
  p_actor uuid, p_actor_role text, p_request_id bigint, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare r public.addon_requests; c public.addon_catalog; v_note text := nullif(btrim(coalesce(p_note,'')),''); v_bill text := '';
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_decision not in ('approve','reject') then raise exception 'INVALID_DECISION'; end if;
  select * into r from public.addon_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status <> 'requested' then raise exception 'REQUEST_NOT_OPEN'; end if;
  select * into c from public.addon_catalog where category = r.category and key = r.key;

  if p_decision = 'approve' then
    -- fn_addon_grant inserts the entitlement; the 0165/0166 trigger bills the QUOTED price of this open request.
    perform public.fn_addon_grant(p_actor, p_actor_role, r.site_id, r.category, r.key);
    update public.addon_requests set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = v_note where id = r.id;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'addon.charge', 'site', r.site_id::text,
              jsonb_build_object('category', r.category, 'key', r.key, 'price_cents', r.price_cents, 'billing_type', r.billing_type,
                                 'setup_fee_cents', r.setup_fee_cents, 'request_id', r.id), r.site_id);
    v_bill := case
      when coalesce(r.billing_type, 'one_off') = 'free' or (r.price_cents = 0 and r.setup_fee_cents = 0) then ''
      when r.billing_type = 'monthly' then ' ' || public.fn_billing_kes(r.price_cents) || ' a month is added to your invoices from the next renewal'
             || case when r.setup_fee_cents > 0 then ', plus a ' || public.fn_billing_kes(r.setup_fee_cents) || ' setup fee on the next invoice' else '' end || '.'
      else ' ' || public.fn_billing_kes(r.price_cents + r.setup_fee_cents) || ' is added to your next invoice.' end;
    insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
      select r.requested_by, 'success', left(coalesce(c.display_name, r.key) || ' approved', 120),
             left(coalesce(c.display_name, r.key) || ' is now available for your brand.' || v_bill || coalesce(' Note: ' || v_note, ''), 1000),
             true, 'addon_request', p_actor, r.site_id
      where r.requested_by is not null;
  else
    update public.addon_requests set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = v_note where id = r.id;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'addon.request.reject', 'site', r.site_id::text,
              jsonb_build_object('category', r.category, 'key', r.key, 'request_id', r.id, 'note', v_note), r.site_id);
    insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
      select r.requested_by, 'warning', left(coalesce(c.display_name, r.key) || ' request declined', 120),
             left('Your request for ' || coalesce(c.display_name, r.key) || ' was declined.' || coalesce(' Reason: ' || v_note, ''), 1000),
             true, 'addon_request', p_actor, r.site_id
      where r.requested_by is not null;
  end if;
  -- (was p_decision || 'd', which answered "rejectd")
  return jsonb_build_object('id', r.id, 'status', case when p_decision = 'approve' then 'approved' else 'rejected' end);
end;
$fn$;

-- ── 10. Bill the quoted price: the charge trigger prefers the open request's snapshot ──────────────
create or replace function public.trg_billing_addon_charge()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare a public.addon_catalog; v_platform uuid; v_site text; v_exempt boolean; q public.addon_requests;
        v_type text; v_price bigint; v_setup bigint;
begin
  select * into a from public.addon_catalog where category = new.category and key = new.key;
  if not found or a.is_default then return new; end if;
  select s.platform_id, s.name into v_platform, v_site from public.sites s where s.id = new.site_id;
  if v_platform is null then return new; end if;
  select coalesce(billing_exempt, false) into v_exempt from public.platform_subscriptions where platform_id = v_platform;
  if coalesce(v_exempt, true) then return new; end if;
  if exists (select 1 from public.billing_charges c where c.site_id = new.site_id and c.source_ref = new.category || ':' || new.key and c.voided_at is null) then
    return new;
  end if;
  select * into q from public.addon_requests
   where site_id = new.site_id and category = new.category and key = new.key and status = 'requested' limit 1;
  v_type  := coalesce(q.billing_type, a.billing_type);
  v_price := case when q.id is not null then q.price_cents else a.price_cents end;
  v_setup := case when q.id is not null then q.setup_fee_cents else a.setup_fee_cents end;
  if v_type = 'one_off' and v_price > 0 then
    insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, source_ref, created_by)
      values (v_platform, new.site_id, 'addon_one_off', a.display_name || ' — ' || v_site, v_price, new.category || ':' || new.key, new.granted_by);
  end if;
  if v_setup > 0 then
    insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, source_ref, created_by)
      values (v_platform, new.site_id, 'addon_setup', a.display_name || ' setup — ' || v_site, v_setup, new.category || ':' || new.key, new.granted_by);
  end if;
  return new;
end;
$fn$;

-- Removing an add-on before it was invoiced cancels its pending one-off / setup charges (nothing to pay for).
-- Already-invoiced charges stay (the brand had it); a later re-grant is not charged again.
create or replace function public.trg_billing_addon_uncharge()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  update public.billing_charges set voided_at = now()
   where site_id = old.site_id and source_ref = old.category || ':' || old.key and invoice_id is null and voided_at is null;
  return old;
end;
$fn$;
drop trigger if exists trg_billing_addon_uncharge on public.brand_entitlements;
create trigger trg_billing_addon_uncharge after delete on public.brand_entitlements for each row execute function public.trg_billing_addon_uncharge();

-- ── 11. Brands switch between chart / trade systems they own ──────────────────────────────────────
create or replace function public.fn_addon_activate(p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_old text;
begin
  if p_site not in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role)) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  if p_category not in ('chart','trade_ui') then raise exception 'NOT_SWITCHABLE'; end if;
  if not exists (select 1 from public.brand_entitlements where site_id = p_site and category = p_category and key = p_key) then
    raise exception 'NOT_ENTITLED';
  end if;
  if p_category = 'chart' then
    select chart_style into v_old from public.sites where id = p_site;
    update public.sites set chart_style = p_key where id = p_site;
  else
    select trade_ui into v_old from public.sites where id = p_site;
    update public.sites set trade_ui = p_key where id = p_site;
  end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.activate', 'site', p_site::text,
            jsonb_build_object('category', p_category, 'from', v_old, 'to', p_key), p_site);
  perform pg_notify('brand_entitlements_changed', p_site::text);
  return jsonb_build_object('site_id', p_site, 'category', p_category, 'key', p_key, 'active', true);
end;
$fn$;

-- ── 12. Owner: every brand with what it owns and uses (the entitlement matrix) ─────────────────────
create or replace function public.fn_addon_brands(p_actor uuid, p_actor_role text)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id', s.id, 'name', s.name, 'slug', s.slug, 'status', s.status,
           'platform_id', s.platform_id, 'platform_name', p.name,
           'chart_style', s.chart_style, 'trade_ui', s.trade_ui,
           'owned', coalesce((select jsonb_agg(e.category || ':' || e.key order by e.category, e.key)
                                from public.brand_entitlements e where e.site_id = s.id), '[]'::jsonb),
           'pending', (select count(*) from public.addon_requests r where r.site_id = s.id and r.status = 'requested')
         ) order by p.name nulls last, s.name), '[]'::jsonb)
  from public.sites s left join public.platforms p on p.id = s.platform_id
  where s.status <> 'archived'
    and s.id in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role))
    and p_actor_role in ('platform_superadmin','platform_admin');
$fn$;

do $g$
declare f text;
begin
  foreach f in array array[
    'fn_addon_catalog_list(text)', 'fn_addon_update(uuid,text,text,text,jsonb)', 'fn_addon_set_price(uuid,text,text,text,bigint)',
    'fn_addon_brand_view(uuid,text,uuid)', 'fn_addon_request(uuid,text,uuid,text,text,text)', 'fn_addon_cancel_request(uuid,text,bigint)',
    'fn_addon_list_requests(uuid,text,text)', 'fn_addon_decide_request(uuid,text,bigint,text,text)', 'trg_billing_addon_charge()',
    'fn_addon_activate(uuid,text,uuid,text,text)', 'fn_addon_brands(uuid,text)', 'trg_billing_addon_uncharge()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$g$;
