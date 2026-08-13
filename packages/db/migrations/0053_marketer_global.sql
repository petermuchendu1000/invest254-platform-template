-- 0053_marketer_global.sql — cross-brand marketer rollup (docs/22 Task R).
--
-- A person can be a marketer on more than one brand. Because identity is per-brand (each brand has
-- its own profiles row, hence its own `affiliates` row), the same real person owns SEVERAL affiliate
-- rows — one per site. This migration adds an OPTIONAL `marketer_global_id` that links those per-site
-- rows to one global identity, purely for REPORTING: money (accrual + payouts) stays strictly per
-- site and is untouched here. The platform report then answers "which marketer brought which client
-- on which site, and their total" in one view.
--
-- All mutations are SECURITY DEFINER, gated to `platform_superadmin`, and write an admin_actions
-- audit row — mirroring the 0052 platform RPCs. Additive + idempotent.

-- ── 1. Global marketer identity (a real person spanning brands). Reporting only. ────────────────
create table if not exists public.marketer_globals (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  created_at timestamptz not null default now()
);

-- ── 2. Link column on affiliates (nullable; null = not yet linked to a global identity). ─────────
alter table public.affiliates add column if not exists marketer_global_id uuid references public.marketer_globals(id);
create index if not exists ix_affiliates_marketer_global on public.affiliates(marketer_global_id);

-- ── 3. Create a global marketer identity (platform_superadmin; audited). ─────────────────────────
create or replace function public.fn_platform_create_marketer_global(
  p_actor uuid, p_actor_role text, p_label text
) returns uuid
language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(btrim(p_label),'') = '' then raise exception 'INVALID_LABEL'; end if;
  insert into public.marketer_globals(label) values (btrim(p_label)) returning id into v_id;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.marketer.create', 'marketer_global', v_id::text,
            jsonb_build_object('label', btrim(p_label)));
  return v_id;
end;
$fn$;

-- ── 4. Link (or unlink with null) an affiliate row to a global identity (platform_superadmin;
--       audited). Reporting-only: it never moves money or changes per-site accrual. ──────────────
create or replace function public.fn_platform_link_marketer(
  p_actor uuid, p_actor_role text, p_affiliate uuid, p_global uuid
) returns public.affiliates
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.affiliates;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_global is not null and not exists (select 1 from public.marketer_globals where id = p_global) then
    raise exception 'MARKETER_GLOBAL_NOT_FOUND';
  end if;
  update public.affiliates a set marketer_global_id = p_global
   where a.user_id = p_affiliate
  returning * into v_row;
  if not found then raise exception 'NOT_AFFILIATE'; end if;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.marketer.link', 'affiliate', p_affiliate::text,
            jsonb_build_object('marketer_global_id', p_global));
  return v_row;
end;
$fn$;

-- ── 5. Cross-brand marketer rollup: one row per (affiliate, site) with clients / GGR / commission,
--       annotated with the global identity so the console can group by person + total across sites.
--       Clients = referred players; GGR + commission come from the site-scoped commission buckets
--       (Task B). Gated to platform_superadmin. ─────────────────────────────────────────────────
create or replace function public.fn_platform_marketer_rollup(p_actor_role text)
returns table(
  marketer_global_id uuid, label text, affiliate_user_id uuid,
  site_id uuid, site_slug text, site_name text,
  clients bigint, ggr_cents bigint, commission_cents bigint
)
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select a.marketer_global_id, mg.label, a.user_id,
           s.id, s.slug, s.name,
           coalesce(rc.n, 0)::bigint,
           coalesce(cc.ggr, 0)::bigint,
           coalesce(cc.commission, 0)::bigint
      from public.affiliates a
      left join public.marketer_globals mg on mg.id = a.marketer_global_id
      join public.sites s on s.id = coalesce(a.site_id, '00000000-0000-0000-0000-000000000001')
      left join lateral (select count(*) n from public.referrals r where r.affiliate_id = a.user_id) rc on true
      left join lateral (select coalesce(sum(ggr),0) ggr, coalesce(sum(commission),0) commission
                           from public.affiliate_commissions ac where ac.affiliate_id = a.user_id) cc on true
     order by a.marketer_global_id nulls last, s.created_at asc, a.user_id asc;
end;
$fn$;

-- ── Grants: service-role only (the engine holds the connection); never anon/authenticated. ───────
do $g$
begin
  revoke all on function public.fn_platform_create_marketer_global(uuid,text,text) from public, anon, authenticated;
  revoke all on function public.fn_platform_link_marketer(uuid,text,uuid,uuid)      from public, anon, authenticated;
  revoke all on function public.fn_platform_marketer_rollup(text)                   from public, anon, authenticated;
  grant execute on function public.fn_platform_create_marketer_global(uuid,text,text) to service_role;
  grant execute on function public.fn_platform_link_marketer(uuid,text,uuid,uuid)     to service_role;
  grant execute on function public.fn_platform_marketer_rollup(text)                  to service_role;
end
$g$;
