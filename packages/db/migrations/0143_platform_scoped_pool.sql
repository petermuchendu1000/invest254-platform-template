-- 0143_platform_scoped_pool.sql — platform-scoped withdrawal-pool distribution (Issue 1 #4).
--
-- WHY: fn_platform_distribute_pool (migration 0092) is platform_superadmin-only and distributes the
-- daily withdrawal pool across EVERY active brand in EVERY platform. Platform admins must manage the
-- pool for THEIR OWN clients without the system owner doing it for them. This adds:
--   * platform_id on the distribution audit (platform_pool_distributions) so history is per-platform;
--   * fn_platform_distribute_pool_scoped(actor, role, platform, total, mode, overrides): a platform
--     admin may only distribute across the ACTIVE sites in ITS platform; per_site overrides naming a
--     site outside the platform are refused (PLATFORM_SCOPE_FORBIDDEN); the system owner may target
--     any platform. It NEVER touches platform_global_config.global_daily_pool_cents (that GLOBAL total
--     belongs to the system-owner flow) — so the existing global distributor is unchanged.
-- Additive + idempotent (create-or-replace + add-column-if-not-exists; no data change).

alter table public.platform_pool_distributions add column if not exists platform_id uuid references public.platforms(id);
create index if not exists idx_pool_dist_platform on public.platform_pool_distributions(platform_id);

create or replace function public.fn_platform_distribute_pool_scoped(
  p_actor uuid, p_actor_role text, p_platform uuid, p_total_cents bigint,
  p_mode text default 'equal', p_overrides jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare n int; base bigint; rem bigint; per jsonb := '{}'::jsonb; s record; amt bigint; i int := 0; total_applied bigint := 0; k text;
begin
  -- Authz: a platform_admin is bounded to its OWN platform; the system owner may target any platform.
  if p_actor_role = 'platform_admin' then
    if p_platform is distinct from (select pr.platform_id from public.profiles pr where pr.id = p_actor) then
      raise exception 'PLATFORM_SCOPE_FORBIDDEN';
    end if;
  elsif p_actor_role <> 'platform_superadmin' then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_platform is null or not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  if p_mode not in ('equal','per_site') then raise exception 'INVALID_MODE'; end if;
  if p_mode = 'equal' and (p_total_cents is null or p_total_cents < 0) then raise exception 'INVALID_AMOUNT'; end if;

  -- per_site: every named site MUST belong to this platform (no cross-platform writes).
  if p_mode = 'per_site' and p_overrides is not null then
    for k in select jsonb_object_keys(p_overrides) loop
      if not exists (select 1 from public.sites where id = k::uuid and platform_id = p_platform) then
        raise exception 'PLATFORM_SCOPE_FORBIDDEN';
      end if;
    end loop;
  end if;

  select count(*) into n from public.sites where status = 'active' and platform_id = p_platform;
  if n = 0 then raise exception 'NO_ACTIVE_SITES'; end if;
  base := case when p_mode='equal' then p_total_cents / n else 0 end;
  rem  := case when p_mode='equal' then p_total_cents - base * n else 0 end;

  for s in select id from public.sites where status = 'active' and platform_id = p_platform order by created_at loop
    if p_mode = 'equal' then
      amt := base + (case when i = 0 then rem else 0 end);
    else
      amt := coalesce((p_overrides->>s.id::text)::bigint, null);
      if amt is null then i := i + 1; continue; end if;   -- per_site: skip sites not named
      if amt < 0 then raise exception 'INVALID_AMOUNT'; end if;
    end if;
    update public.sites set default_daily_pool_cents = amt where id = s.id;
    per := per || jsonb_build_object(s.id::text, amt);
    total_applied := total_applied + amt;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'platform.pool.distribute', 'site', s.id::text,
              jsonb_build_object('default_daily_pool_cents', amt, 'mode', p_mode, 'platform_id', p_platform), s.id);
    i := i + 1;
  end loop;

  insert into public.platform_pool_distributions(total_cents, mode, site_count, per_site, distributed_by, platform_id)
    values (coalesce(p_total_cents, total_applied), p_mode, (select count(*)::int from jsonb_object_keys(per)), per, p_actor, p_platform);
  -- Intentionally does NOT update platform_global_config (that GLOBAL total is the system-owner's).
  perform pg_notify('platform_config_changed', 'pool');
  return jsonb_build_object('total_cents', coalesce(p_total_cents, total_applied), 'mode', p_mode, 'per_site', per, 'platform_id', p_platform);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_platform_distribute_pool_scoped(uuid,text,uuid,bigint,text,jsonb) from public, anon, authenticated;
  grant execute on function public.fn_platform_distribute_pool_scoped(uuid,text,uuid,bigint,text,jsonb) to service_role;
end
$g$;
