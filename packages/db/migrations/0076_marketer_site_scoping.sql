-- 0076_marketer_site_scoping.sql — make the marketers module multi-tenant (per-site).
--
-- Background: migration 0033 created `marketers` as a GLOBAL cohort keyed by a unique phone. Under
-- the mothership/franchise model every brand is an independent storefront, so a marketer must belong
-- to exactly one brand and the same phone may exist on two brands as two separate marketer accounts.
--
-- This migration threads `site_id` onto `marketers`, swaps the global phone-unique for a per-brand
-- (site_id, phone) unique, and promotes fn_marketer_create / fn_marketer_login to be site-aware
-- (3-arg, defaulting to the platform's default site so legacy 2-arg call sites keep working).
--
-- Idempotent + additive: safe to re-run; existing marketers are backfilled to the default brand.

-- ── 1) site_id column: backfill to default brand, then NOT NULL + default + FK + index ───────────
alter table public.marketers add column if not exists site_id uuid;
update public.marketers set site_id = '00000000-0000-0000-0000-000000000001'::uuid where site_id is null;
alter table public.marketers alter column site_id set default '00000000-0000-0000-0000-000000000001'::uuid;
alter table public.marketers alter column site_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'marketers_site_fk') then
    alter table public.marketers
      add constraint marketers_site_fk foreign key (site_id) references public.sites(id);
  end if;
end $$;
create index if not exists ix_marketers_site on public.marketers(site_id);

-- ── 2) uniqueness is now per-brand: drop the global phone-unique, add (site_id, phone) ───────────
alter table public.marketers drop constraint if exists marketers_phone_key;
drop index if exists public.marketers_phone_key;
create unique index if not exists uq_marketers_site_phone on public.marketers(site_id, phone);

-- ── 3) site-aware create (3-arg; upsert by (site_id, phone); default site when omitted/NULL) ─────
create or replace function public.fn_marketer_create(p_name text, p_phone text, p_site_id uuid default '00000000-0000-0000-0000-000000000001'::uuid)
returns public.marketers
language plpgsql
as $function$
declare m public.marketers; v_site uuid := coalesce(p_site_id, '00000000-0000-0000-0000-000000000001');
begin
  if p_name  is null or length(btrim(p_name))  = 0 then raise exception 'NAME_REQUIRED'; end if;
  if p_phone is null or length(btrim(p_phone)) = 0 then raise exception 'PHONE_REQUIRED'; end if;
  if not exists (select 1 from public.sites s where s.id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.marketers(name, phone, site_id)
    values (btrim(p_name), btrim(p_phone), v_site)
    on conflict (site_id, phone) do update set name = excluded.name, updated_at = now()
    returning * into m;
  insert into public.marketer_wallets(marketer_id) values (m.id)
    on conflict (marketer_id) do nothing;
  return m;
end
$function$;

-- ── 4) site-aware login (3-arg; scopes the phone lookup to the brand; default site when omitted) ─
create or replace function public.fn_marketer_login(p_phone text, p_pin text, p_site_id uuid default '00000000-0000-0000-0000-000000000001'::uuid)
returns uuid
language plpgsql
as $function$
declare m record; c record; v_site uuid := coalesce(p_site_id, '00000000-0000-0000-0000-000000000001');
begin
  select id, status into m from public.marketers
    where phone = btrim(coalesce(p_phone, '')) and site_id = v_site;
  if not found then return null; end if;
  select * into c from public.marketer_credentials where marketer_id = m.id for update;
  if not found then return null; end if;
  if c.locked_until is not null and c.locked_until > now() then return null; end if;
  if m.status <> 'active' then return null; end if;
  if c.pin_hash = extensions.crypt(coalesce(p_pin, ''), c.pin_hash) then
    update public.marketer_credentials set failed_attempts = 0, locked_until = null, updated_at = now()
      where marketer_id = m.id;
    return m.id;
  end if;
  update public.marketer_credentials
    set failed_attempts = c.failed_attempts + 1,
        locked_until = case when c.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
        updated_at = now()
    where marketer_id = m.id;
  return null;
end
$function$;

-- ── 5) helper: resolve a marketer's brand (used by the app layer for scope checks) ───────────────
create or replace function public.fn_marketer_site(p_id uuid)
returns uuid
language sql
stable
as $function$
  select site_id from public.marketers where id = p_id
$function$;
