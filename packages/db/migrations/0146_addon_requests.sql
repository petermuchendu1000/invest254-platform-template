-- 0146_addon_requests.sql — request -> approve workflow + the brand-facing catalog view (Issue 2).
--
-- An operator (site admin for its brand; platform admin for a brand in its platform) REQUESTS an add-on;
-- the SYSTEM ADMIN approves (grant + record the agreed charge) or rejects. Requesters and the system
-- admin are notified via user_notifications (same channel as tickets). Scope reuses fn_actor_target_sites
-- (0141): a site admin sees only its brand's requests, a platform admin its platform's, the system all.
-- Additive + idempotent.

create table if not exists public.addon_requests (
  id           bigint generated always as identity primary key,
  site_id      uuid not null references public.sites(id) on delete cascade,
  category     text not null check (category in ('chart','trade_ui','payment_gateway')),
  key          text not null,
  status       text not null default 'requested' check (status in ('requested','approved','rejected','cancelled')),
  price_cents  bigint not null default 0,                 -- snapshot of the catalog price at request time
  requested_by uuid references public.profiles(id),
  note         text,
  decided_by   uuid references public.profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_addon_requests_site on public.addon_requests(site_id);
-- At most ONE open request per (brand, category, key).
create unique index if not exists uq_addon_request_open on public.addon_requests(site_id, category, key) where status = 'requested';
alter table public.addon_requests enable row level security;

-- ── Requester view of a brand's catalog: price + entitled + active + pending, scoped. ───────────
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
$fn$;

-- ── Create a request (site admin: own brand; platform admin: brand in its platform). ────────────
create or replace function public.fn_addon_request(
  p_actor uuid, p_actor_role text, p_site uuid, p_category text, p_key text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_price bigint; v_slug text; v_id bigint;
begin
  if p_site not in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role)) then
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
$fn$;

-- ── List requests, scoped (system all; platform admin its platform; site admin its own brand). ──
create or replace function public.fn_addon_list_requests(p_actor uuid, p_actor_role text, p_status text default null)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'site_id', r.site_id, 'slug', s.slug, 'name', s.name,
           'category', r.category, 'key', r.key, 'status', r.status, 'price_cents', r.price_cents,
           'note', r.note, 'requested_by', r.requested_by, 'created_at', r.created_at,
           'decided_by', r.decided_by, 'decided_at', r.decided_at
         ) order by r.created_at desc), '[]'::jsonb)
  from public.addon_requests r join public.sites s on s.id = r.site_id
  where r.site_id in (select site_id from public.fn_actor_target_sites(p_actor, p_actor_role))
    and (p_status is null or r.status = p_status);
$fn$;

-- ── Decide a request (SYSTEM admin only): approve => grant + record charge + notify; reject => notify. ──
create or replace function public.fn_addon_decide_request(
  p_actor uuid, p_actor_role text, p_request_id bigint, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare r public.addon_requests;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_decision not in ('approve','reject') then raise exception 'INVALID_DECISION'; end if;
  select * into r from public.addon_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status <> 'requested' then raise exception 'REQUEST_NOT_OPEN'; end if;

  if p_decision = 'approve' then
    perform public.fn_addon_grant(p_actor, p_actor_role, r.site_id, r.category, r.key);   -- entitle (+active)
    update public.addon_requests set status = 'approved', decided_by = p_actor, decided_at = now(),
      note = coalesce(nullif(btrim(coalesce(p_note,'')),''), note) where id = r.id;
    -- Record the agreed charge (light billing hook; full invoicing later).
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'addon.charge', 'site', r.site_id::text,
              jsonb_build_object('category', r.category, 'key', r.key, 'price_cents', r.price_cents, 'request_id', r.id), r.site_id);
    insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
      select r.requested_by, 'success', 'Add-on approved',
             format('Your request for "%s" (%s) was approved and is now active.', r.key, r.category),
             true, 'addon_request', p_actor, r.site_id
      where r.requested_by is not null;
  else
    update public.addon_requests set status = 'rejected', decided_by = p_actor, decided_at = now(),
      note = coalesce(nullif(btrim(coalesce(p_note,'')),''), note) where id = r.id;
    insert into public.user_notifications(user_id, level, title, body, dismissible, category, created_by, site_id)
      select r.requested_by, 'warning', 'Add-on request declined',
             format('Your request for "%s" (%s) was declined.%s', r.key, r.category,
                    case when nullif(btrim(coalesce(p_note,'')),'') is not null then ' Note: ' || p_note else '' end),
             true, 'addon_request', p_actor, r.site_id
      where r.requested_by is not null;
  end if;
  return jsonb_build_object('id', r.id, 'status', p_decision || 'd');
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_addon_brand_view(uuid,text,uuid)                            from public, anon, authenticated;
  revoke all on function public.fn_addon_request(uuid,text,uuid,text,text,text)                 from public, anon, authenticated;
  revoke all on function public.fn_addon_list_requests(uuid,text,text)                          from public, anon, authenticated;
  revoke all on function public.fn_addon_decide_request(uuid,text,bigint,text,text)             from public, anon, authenticated;
  grant execute on function public.fn_addon_brand_view(uuid,text,uuid)                          to service_role;
  grant execute on function public.fn_addon_request(uuid,text,uuid,text,text,text)              to service_role;
  grant execute on function public.fn_addon_list_requests(uuid,text,text)                       to service_role;
  grant execute on function public.fn_addon_decide_request(uuid,text,bigint,text,text)          to service_role;
  grant select, insert, update, delete on public.addon_requests to service_role;
end
$g$;
