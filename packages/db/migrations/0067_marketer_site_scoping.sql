-- 0067_marketer_site_scoping.sql — make the marketer payments module (0033/0034) PER-SITE.
--
-- WHY: the `marketers` table shipped GLOBAL (phone was globally UNIQUE, no site_id), so every
-- brand's admin console listed the SAME marketers — e.g. madolar.com showed invest254's marketers.
-- The locked multi-tenant model (docs/20) is "marketer identity = PER-SITE"; this migration finally
-- threads `site_id` through the module so each brand only ever sees/creates/authenticates its own
-- marketers. Money tables (marketer_wallets/ledger/withdrawals/credentials) stay keyed by the
-- marketer's uuid, so they inherit the brand transitively — no column churn there.
--
-- Backfill: all pre-existing marketers predate multi-tenancy and belong to the original invest254
-- deployment, so they backfill to the DEFAULT site (00000000-…-000000000001), mirroring 0045.
--
-- Identity model: uniqueness becomes PER-SITE — the same phone may be a marketer on two brands
-- (two rows), exactly like players/affiliates. Login/profile lookups by phone therefore MUST be
-- scoped to the requesting brand (the RPCs below take p_site_id; a NULL falls back to the default
-- site so single-tenant/legacy callers are unchanged).
--
-- Idempotent + additive (safe to re-run).

do $mig$
declare
  default_site constant uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- ── 1. site_id on marketers: add (nullable) → backfill → FK → default → NOT NULL ──────────────
  alter table public.marketers add column if not exists site_id uuid;
  update public.marketers set site_id = default_site where site_id is null;
  begin
    alter table public.marketers
      add constraint marketers_site_fk foreign key (site_id) references public.sites(id);
  exception when duplicate_object then null; end;
  alter table public.marketers alter column site_id set default '00000000-0000-0000-0000-000000000001';
  alter table public.marketers alter column site_id set not null;

  -- ── 2. Per-site identity: drop the GLOBAL phone unique, add composite (site_id, phone) ─────────
  alter table public.marketers drop constraint if exists marketers_phone_key;
  create unique index if not exists uq_marketers_site_phone on public.marketers(site_id, phone);
  create index if not exists ix_marketers_site on public.marketers(site_id);
end
$mig$;

-- ── 3. Brand-aware profile view (adds site_id so the API can filter the list per brand) ──────────
create or replace view public.marketer_profiles as
select
  m.id, m.name,
  public.fn_first_name(m.name) as first_name,
  public.fn_initials(m.name)   as initials,
  m.phone, m.status,
  w.balance_cents,
  w.available_fuliza_cents,
  w.airtime_balance_cents,
  w.currency,
  w.updated_at as wallet_updated_at,
  m.created_at,
  m.site_id
from public.marketers m
join public.marketer_wallets w on w.marketer_id = m.id;

-- ── 4. Create/upsert a marketer WITHIN a brand (per-site phone) ──────────────────────────────────
-- Replaces the 2-arg 0033 version. Drop the old signature so the 3-arg form is unambiguous.
drop function if exists public.fn_marketer_create(text, text);
create or replace function public.fn_marketer_create(
  p_name text, p_phone text, p_site_id uuid default '00000000-0000-0000-0000-000000000001'
)
returns public.marketers
language plpgsql as $func$
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
$func$;

-- ── 5. Site-scoped login (resolve the marketer by phone WITHIN the requesting brand) ─────────────
drop function if exists public.fn_marketer_login(text, text);
create or replace function public.fn_marketer_login(
  p_phone text, p_pin text, p_site_id uuid default '00000000-0000-0000-0000-000000000001'
)
returns uuid
language plpgsql as $func$
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
$func$;

-- ── 6. Helper: the brand a marketer belongs to (for admin by-id scope guards in the API) ─────────
create or replace function public.fn_marketer_site(p_id uuid)
returns uuid
language sql stable as $$
  select site_id from public.marketers where id = p_id
$$;
