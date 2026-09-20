-- 0144_addon_catalog.sql — the sellable "system" catalog + prices (Issue 2).
--
-- One unified catalog of add-on "systems" a brand can run, across three categories:
--   chart            — price-chart rendering system (line is the free default; others are paid add-ons)
--   trade_ui         — trade-interface layout (classic is the free default; digits is a paid add-on)
--   payment_gateway  — deposit/withdraw rail (M-Pesa/Daraja is the free default; others are paid)
-- The SYSTEM ADMIN (platform_superadmin) sets prices; every operator (admin+) may READ the catalog so
-- they can see what is available and request it. Prices are seeded once (insert-only) then edited in
-- console via fn_addon_set_price — re-applying this migration never resets an edited price. Additive +
-- idempotent. Entitlements (who owns what) + requests live in 0145/0146.

create table if not exists public.addon_catalog (
  category      text   not null check (category in ('chart','trade_ui','payment_gateway')),
  key           text   not null,
  display_name  text   not null,
  price_cents   bigint not null default 0 check (price_cents >= 0),   -- KES cents; 0 = free
  is_default    boolean not null default false,                        -- the free default of its category
  active        boolean not null default true,                         -- hidden from catalog when false
  sort_order    int    not null default 100,
  updated_by    uuid   references public.profiles(id),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  primary key (category, key)
);
alter table public.addon_catalog enable row level security;

-- Seed the catalog (insert-only: never clobber an admin-edited price on re-apply). Prices in KES cents.
insert into public.addon_catalog (category, key, display_name, price_cents, is_default, sort_order) values
  ('chart','line','Line graph',0,true,10),
  ('chart','area','Area graph',0,false,20),
  ('chart','candlestick','Candlesticks',0,false,30),
  ('chart','bars','OHLC bars',0,false,40),
  ('chart','baseline','Baseline',0,false,50),
  ('trade_ui','classic','Classic terminal',0,true,10),
  ('trade_ui','digits','Digits broker screen',0,false,20),
  ('payment_gateway','mpesa','M-Pesa (Daraja)',0,true,10),
  ('payment_gateway','megapay','Mega Pay',1000000,false,20),
  ('payment_gateway','paystack','Paystack',1000000,false,30),
  ('payment_gateway','binance','Binance Pay',1000000,false,40),
  ('payment_gateway','stripe','Stripe',1500000,false,50)
on conflict (category, key) do nothing;

-- ── Read the catalog (any operator: admin+). Returns prices so requesters see the cost. ──────────
create or replace function public.fn_addon_catalog_list(p_actor_role text)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'category', c.category, 'key', c.key, 'display_name', c.display_name,
           'price_cents', c.price_cents, 'is_default', c.is_default, 'active', c.active,
           'sort_order', c.sort_order, 'updated_at', c.updated_at
         ) order by c.category, c.sort_order, c.key), '[]'::jsonb)
  from public.addon_catalog c
  where p_actor_role in ('admin','superadmin','platform_admin','platform_superadmin')
    and c.active;
$fn$;

-- ── Set a price (SYSTEM admin only). ─────────────────────────────────────────────────────────────
create or replace function public.fn_addon_set_price(
  p_actor uuid, p_actor_role text, p_category text, p_key text, p_price_cents bigint)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v public.addon_catalog; v_site uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_price_cents is null or p_price_cents < 0 then raise exception 'INVALID_AMOUNT'; end if;
  update public.addon_catalog set price_cents = p_price_cents, updated_by = p_actor, updated_at = now()
    where category = p_category and key = p_key returning * into v;
  if not found then raise exception 'ADDON_NOT_FOUND'; end if;
  select id into v_site from public.sites order by created_at limit 1;   -- admin_actions.site_id NOT NULL
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'addon.set_price', 'addon', p_category || ':' || p_key,
            jsonb_build_object('price_cents', p_price_cents), coalesce(v_site, '00000000-0000-0000-0000-000000000001'::uuid));
  perform pg_notify('addon_catalog_changed', p_category || ':' || p_key);
  return jsonb_build_object('category', v.category, 'key', v.key, 'price_cents', v.price_cents);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_addon_catalog_list(text)                         from public, anon, authenticated;
  revoke all on function public.fn_addon_set_price(uuid,text,text,text,bigint)       from public, anon, authenticated;
  grant execute on function public.fn_addon_catalog_list(text)                       to service_role;
  grant execute on function public.fn_addon_set_price(uuid,text,text,text,bigint)     to service_role;
  grant select, insert, update, delete on public.addon_catalog to service_role;
end
$g$;
