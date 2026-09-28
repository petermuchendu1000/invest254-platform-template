-- 0173_bonus_scope_switches.sql — bonuses get a PER-PLATFORM and PER-BRAND on/off switch.
--
-- WHAT EXISTS TODAY (verified against production, 2026-09-28):
--   `bonus_config` is a SINGLETON (`id int primary key check (id = 1)`), so `welcome_enabled` is one
--   global flag for every platform and every brand. There is no per-platform or per-brand control,
--   and no API/admin surface for it at all — the only way to switch bonuses off was a manual UPDATE
--   on the singleton, which would switch them off for EVERY client at once.
--
--   `fn_grant_welcome_bonus` is the ONLY function in the database that grants a bonus (confirmed by
--   scanning every `prokind='f'` routine for an insert into `bonuses`; the 0037 deposit-bonus grant
--   was removed at 0077/0078 and its tier helper dropped at 0094). Gating that one function is
--   therefore complete coverage — there is no second grant path to keep in sync.
--
-- WHAT THIS ADDS — a three-level switch, composed exactly like the existing money kill-switches
-- (`platform_global_config.withdrawals_enabled` AND `sites.withdrawals_enabled`, 0067/0092):
--
--     system (bonus_config.welcome_enabled)  AND  platform (platforms.bonuses_enabled)
--                                            AND  brand    (sites.bonuses_enabled)
--
--   AND, not "nearest wins": a switch is a safety control, so any level must be able to stop the
--   spend, and no lower level may re-enable what a higher one has stopped. Defaults are TRUE at both
--   new levels, so this migration is BEHAVIOUR-NEUTRAL until an operator flips something.
--
-- SCOPE OF A FLIP (deliberate): switching bonuses off stops FUTURE grants only. Bonuses already
-- granted keep their wagering progress and still convert on `fn_settle_position` — turning the tap
-- off must never confiscate money a player was already given (12 brands hold 1,470 active welcome
-- bonuses worth KES 294,000 at the time of writing).
--
-- Additive + idempotent. Money-neutral: no balance, ledger row or bonus row is touched here.
begin;

-- ── 1. The two new switch columns (default TRUE = today's behaviour) ─────────────────────────────
alter table public.platforms add column if not exists bonuses_enabled boolean not null default true;
alter table public.sites     add column if not exists bonuses_enabled boolean not null default true;

-- ── 2. Effective resolution: system AND platform AND brand ───────────────────────────────────────
-- A site that cannot be resolved (null / unknown id, or a wallet whose brand row is gone) falls back
-- to the SYSTEM switch alone — i.e. exactly today's behaviour. Fail-open at the scope levels,
-- fail-closed at the system level, which is the semantics the grant already had.
create or replace function public.fn_bonuses_enabled(p_site uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce((select c.welcome_enabled from public.bonus_config c where c.id = 1), false)
     and coalesce((select s.bonuses_enabled and pl.bonuses_enabled
                     from public.sites s
                     join public.platforms pl on pl.id = s.platform_id
                    where s.id = p_site), true);
$fn$;

-- Admin-facing breakdown: WHICH level switched bonuses off, so the console can say so instead of
-- showing a switch that appears on but has no effect.
create or replace function public.fn_bonus_switches(p_site uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'site_id',     p_site,
    'platform_id', (select s.platform_id from public.sites s where s.id = p_site),
    'system',      coalesce((select c.welcome_enabled from public.bonus_config c where c.id = 1), false),
    'platform',    coalesce((select pl.bonuses_enabled from public.sites s
                               join public.platforms pl on pl.id = s.platform_id
                              where s.id = p_site), true),
    'brand',       coalesce((select s.bonuses_enabled from public.sites s where s.id = p_site), true),
    'effective',   public.fn_bonuses_enabled(p_site),
    'amount_cents',(select c.welcome_amount_cents from public.bonus_config c where c.id = 1),
    'wagering_x',  (select c.welcome_wagering_x   from public.bonus_config c where c.id = 1));
$fn$;

-- ── 3. The grant honours the scoped switch ───────────────────────────────────────────────────────
-- Byte-for-byte the live 0094 body, with ONE change: the global `welcome_enabled` test is replaced by
-- `fn_bonuses_enabled(v_site)` (which still includes it) once the wallet lock has resolved the brand.
-- With every switch on, the outcome is identical to today for every account.
create or replace function public.fn_grant_welcome_bonus(p_user uuid)
returns bigint
language plpgsql security definer set search_path = public
as $fn$
declare v_amount bigint; v_wx numeric; v_site uuid; v_bonus_id uuid;
begin
  select welcome_amount_cents, welcome_wagering_x
    into v_amount, v_wx
    from bonus_config where id = 1;
  if not found or coalesce(v_amount, 0) <= 0 then
    return 0;
  end if;

  -- Demo/marketer (social-proof) accounts never receive a real welcome bonus.
  if public.fn_is_marketer_account(p_user) then
    return 0;
  end if;

  -- Lock the wallet row for the duration; also resolves the account's brand for scoping.
  select site_id into v_site from wallets where user_id = p_user for update;
  if not found then
    return 0;   -- no wallet (should never happen post-registration) → nothing to credit
  end if;

  -- Switched off by the system owner, by this brand's platform, or by the brand itself (0173).
  if not public.fn_bonuses_enabled(v_site) then
    return 0;
  end if;

  -- Idempotent: one welcome bonus per user. The partial unique index is the race-proof backstop.
  if exists (select 1 from bonuses where user_id = p_user and type = 'welcome') then
    return 0;
  end if;

  insert into bonuses(user_id, site_id, type, amount, wagering_x, status)
    values (p_user, v_site, 'welcome', v_amount, v_wx, 'active')
    on conflict (user_id) where type = 'welcome' do nothing
    returning id into v_bonus_id;
  if v_bonus_id is null then
    return 0;   -- lost the race; another connection granted it
  end if;

  update wallets set bonus_balance = bonus_balance + v_amount where user_id = p_user;
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, v_site, 'bonus', v_amount, 'bonus', 'bonuses', v_bonus_id::text,
            jsonb_build_object('kind', 'welcome_bonus', 'wagering_x', v_wx));
  return v_amount;
end;
$fn$;

-- ── 4. Brand-level toggle (audited) — mirrors fn_admin_set_withdrawals_enabled (0067) ────────────
-- A site-scoped admin may only flip its own brand; the API layer enforces that from the token's site
-- claim before calling. SECURITY DEFINER so it works regardless of the API's DB role.
create or replace function public.fn_admin_set_bonuses_enabled(
  p_actor uuid, p_actor_role text, p_site uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = public
as $fn$
begin
  -- 0067's allow-list also carried the legacy `superadmin` tier; it was removed (docs/42 UI-11), so
  -- no such token can exist and it is deliberately NOT repeated here.
  if p_actor_role not in ('admin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.sites set bonuses_enabled = p_enabled, updated_at = now() where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'bonuses.toggle', 'site', p_site::text,
            jsonb_build_object('bonuses_enabled', p_enabled), p_site);
  return p_enabled;
end;
$fn$;

-- ── 5. Platform-level toggle (audited) ───────────────────────────────────────────────────────────
-- The system owner may flip any platform; a platform admin may flip ONLY the platform its profile is
-- bound to. That scope is re-checked here against `profiles.platform_id` rather than trusted from the
-- caller, so the API's scope guard is defence in depth and not the only gate.
create or replace function public.fn_platform_set_bonuses_enabled(
  p_actor uuid, p_actor_role text, p_platform uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = public
as $fn$
declare v_site uuid;
begin
  if p_actor_role = 'platform_admin' then
    if not exists (select 1 from public.profiles
                    where id = p_actor and role = 'platform_admin' and platform_id = p_platform) then
      raise exception 'NOT_AUTHORIZED';
    end if;
  elsif p_actor_role <> 'platform_superadmin' then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.platforms set bonuses_enabled = p_enabled, updated_at = now() where id = p_platform;
  if not found then raise exception 'PLATFORM_NOT_FOUND'; end if;
  -- admin_actions.site_id is NOT NULL; anchor the platform-level row to one of its brands (0092 uses
  -- the same trick with the default site). Falls back to the oldest site if the platform has none.
  select id into v_site from public.sites where platform_id = p_platform order by created_at limit 1;
  if v_site is null then select id into v_site from public.sites order by created_at limit 1; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.bonuses.toggle', 'platform', p_platform::text,
            jsonb_build_object('bonuses_enabled', p_enabled), v_site);
  return p_enabled;
end;
$fn$;

-- ── 6. Grants: service-role only (player/admin reads go through the API) ─────────────────────────
do $g$
begin
  revoke all on function public.fn_bonuses_enabled(uuid)                                  from public, anon, authenticated;
  revoke all on function public.fn_bonus_switches(uuid)                                   from public, anon, authenticated;
  revoke all on function public.fn_admin_set_bonuses_enabled(uuid,text,uuid,boolean)      from public, anon, authenticated;
  revoke all on function public.fn_platform_set_bonuses_enabled(uuid,text,uuid,boolean)   from public, anon, authenticated;
  grant execute on function public.fn_bonuses_enabled(uuid)                                to service_role;
  grant execute on function public.fn_bonus_switches(uuid)                                 to service_role;
  grant execute on function public.fn_admin_set_bonuses_enabled(uuid,text,uuid,boolean)    to service_role;
  grant execute on function public.fn_platform_set_bonuses_enabled(uuid,text,uuid,boolean) to service_role;
end
$g$;

commit;

-- REVERT (manual, if ever needed):
--   1. Restore fn_grant_welcome_bonus from 0094 (verbatim body).
--   2. drop function if exists public.fn_platform_set_bonuses_enabled(uuid,text,uuid,boolean);
--      drop function if exists public.fn_admin_set_bonuses_enabled(uuid,text,uuid,boolean);
--      drop function if exists public.fn_bonus_switches(uuid);
--      drop function if exists public.fn_bonuses_enabled(uuid);
--   3. alter table public.sites     drop column if exists bonuses_enabled;
--      alter table public.platforms drop column if exists bonuses_enabled;
