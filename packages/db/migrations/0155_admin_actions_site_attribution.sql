-- 0155_admin_actions_site_attribution.sql — Issue 1 / F-45 (BUGLOG #45): every audit row is filed under
-- the brand it actually concerns — or under NO brand when it is platform-level.
--
-- BUG: admin_actions.site_id was NOT NULL DEFAULT <default brand>, and 26 of 50 audit-writing functions
-- plus the API's recordAction() never set it. So every such row landed on the DEFAULT brand whatever it
-- touched (prod 2026-09-23: all 570 'user' rows on the default brand; 256 of them concern users of
-- OTHER brands). Consequences:
--   * GET /platform/sites/:id/audit (platform admin, filtered by site_id) showed the default brand's
--     operators actions taken on OTHER platforms' users (cross-platform leak), and hid each brand's own
--     actions from its platform admin;
--   * platform-level actions (create platform, global config, provider config) masqueraded as the
--     default brand's.
--
-- FIX:
--   1) site_id becomes NULLABLE with no default. NULL = platform-level (no brand); per-brand audit views
--      (`site_id = $brand`) exclude it; the system owner (unfiltered) still sees everything.
--   2) fn_admin_action_site(type, target, detail): the brand of the TOUCHED entity —
--        user|profiles|affiliate|marketer -> profiles (marketer also marketers) ;
--        site|site_game_config|withdrawal_pool('<site>:<day>') -> the site itself ;
--        transaction -> transactions ; marketer_advance_requests -> itself ;
--        notification -> user_notifications ;
--      else detail.site_id / detail.after.site_id when it names a real brand; else NULL.
--   3) BEFORE INSERT trigger: the derived brand is AUTHORITATIVE (overrides a wrong/missing value). With
--      nothing derivable, a GENUINE site admin's untargeted action (e.g. a brand broadcast) is filed under
--      its own brand; anything else (system, platform admin, impersonation) stays NULL — never guessed.
--   4) Backfill with the same rule. Legacy single-tenant rows for the pre-multitenant singleton
--      game_config (target '1', before per-brand configs existed) stay on the default brand, which WAS
--      the only brand then; mpesa_config/platform/provider/template/addon rows become platform-level.
-- Idempotent. No reader breaks: the only readers are listAudit (site filter or none).

alter table public.admin_actions alter column site_id drop default;
alter table public.admin_actions alter column site_id drop not null;

create or replace function public.fn_admin_action_site(p_type text, p_target text, p_detail jsonb)
returns uuid
language plpgsql stable security definer set search_path = public
as $fn$
declare v uuid; v_uuid uuid; v_s text;
begin
  if p_target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
    v_uuid := left(p_target, 36)::uuid;
  end if;
  if p_type in ('user', 'profiles', 'affiliate', 'marketer') and v_uuid is not null then
    select site_id into v from public.profiles where id = v_uuid;
    if v is null and p_type = 'marketer' then select site_id into v from public.marketers where id = v_uuid; end if;
  elsif p_type in ('site', 'site_game_config', 'withdrawal_pool') and v_uuid is not null then
    select id into v from public.sites where id = v_uuid;
  elsif p_type = 'transaction' and v_uuid is not null then
    select site_id into v from public.transactions where id = v_uuid;
  elsif p_type = 'marketer_advance_requests' and v_uuid is not null then
    select site_id into v from public.marketer_advance_requests where id = v_uuid;
  elsif p_type = 'notification' and p_target ~ '^[0-9]{1,18}$' then
    select site_id into v from public.user_notifications where id = p_target::bigint;
  end if;
  if v is null and p_detail is not null then
    v_s := coalesce(p_detail ->> 'site_id', p_detail -> 'after' ->> 'site_id');
    if v_s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into v from public.sites where id = v_s::uuid;
    end if;
  end if;
  return v;
end;
$fn$;

create or replace function public.fn_admin_actions_attribute()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare v uuid;
begin
  v := public.fn_admin_action_site(new.target_type, new.target_id, new.detail);
  if v is not null then
    new.site_id := v;                                  -- the touched entity's brand is authoritative
  elsif new.site_id is null and new.actor_role = 'admin' then
    -- untargeted action by a GENUINE site admin (profile role 'admin') -> its own brand; an
    -- impersonating operator (profile role platform_*) stays NULL rather than mis-filed (F-46).
    select p.site_id into new.site_id from public.profiles p where p.id = new.actor_id and p.role = 'admin';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_admin_actions_attribute on public.admin_actions;
create trigger trg_admin_actions_attribute before insert on public.admin_actions
  for each row execute function public.fn_admin_actions_attribute();

revoke execute on function public.fn_admin_action_site(text, text, jsonb) from anon, authenticated, public;
revoke execute on function public.fn_admin_actions_attribute() from anon, authenticated, public;
grant  execute on function public.fn_admin_action_site(text, text, jsonb) to service_role;

-- Backfill with the same rule. The target-derived brand always wins. Otherwise only rows currently on
-- the DEFAULT brand (i.e. possibly just DEFAULTED) are recomputed via the fallbacks; a deliberately set
-- non-default site_id is kept.
with d as (
  select a.id, a.site_id as cur,
         public.fn_admin_action_site(a.target_type, a.target_id, a.detail) as derived,
         coalesce(
           case when a.target_type = 'game_config' then '00000000-0000-0000-0000-000000000001'::uuid end,  -- legacy singleton era
           case when a.actor_role = 'admin' then (select p.site_id from public.profiles p where p.id = a.actor_id and p.role = 'admin') end
         ) as fallback
    from public.admin_actions a
), t as (
  select id, cur,
         case when derived is not null then derived
              when cur = '00000000-0000-0000-0000-000000000001'::uuid then fallback
              else cur end as site
    from d
)
update public.admin_actions a
   set site_id = t.site
  from t
 where t.id = a.id
   and a.site_id is distinct from t.site;
