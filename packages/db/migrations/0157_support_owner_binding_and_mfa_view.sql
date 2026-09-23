-- 0157_support_owner_binding_and_mfa_view.sql — Issue 1 / F-48 (BUGLOG #49).
--
-- (1) SUPPORT CONVERSATIONS WERE NOT OWNER-BOUND. Knowing a conversation id was enough to post into it
--     (and have the assistant replay its earlier turns), or to re-point its escalation contact so staff
--     follow up with a stranger. Each conversation now carries the SHA-256 of a random capability
--     token issued ONCE, at creation, to the browser that opened it. The API requires that token (or
--     the logged-in owner) for every write. Only the hash is stored; the token is never logged.
--     Conversations created before this migration have no hash and can no longer be written to — the
--     widget transparently starts a new one (prod: 4 conversations, last activity 2026-08-15).
--
-- (2) v_mfa_status WAS STALE. It listed only ('admin','superadmin') — the removed legacy tier — and hid
--     both platform tiers (platform_admin, platform_superadmin), whose 2FA is mandatory. It was also
--     granted to anon/authenticated (blocked only because user_mfa is not readable by them). Rebuilt for
--     the live operator tiers with brand/platform columns, security_invoker, service_role only.
--
-- Deploy-order safe: the 3-arg fn_support_start is kept for the previously deployed API; the new
-- 4-arg overload has NO defaults, so a 3-arg call can never resolve to it. Idempotent.

alter table public.support_conversations
  add column if not exists access_hash text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'support_conversations_access_hash_chk') then
    alter table public.support_conversations
      add constraint support_conversations_access_hash_chk
      check (access_hash is null or access_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create or replace function public.fn_support_start(p_site_id uuid, p_visitor text, p_user uuid, p_access_hash text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid;
begin
  if not exists (select 1 from public.sites where id = p_site_id) then raise exception 'SITE_NOT_FOUND'; end if;
  if p_access_hash is null or p_access_hash !~ '^[0-9a-f]{64}$' then raise exception 'ACCESS_HASH_REQUIRED'; end if;
  insert into public.support_conversations(site_id, visitor_id, user_id, access_hash)
    values (p_site_id, nullif(btrim(coalesce(p_visitor,'')),''), p_user, p_access_hash)
    returning id into v_id;
  return v_id;
end $fn$;

revoke all on function public.fn_support_start(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.fn_support_start(uuid,text,uuid,text) to service_role;

-- ── (2) MFA status for the LIVE operator tiers ─────────────────────────────────────────────────────
drop view if exists public.v_mfa_status;
create view public.v_mfa_status with (security_invoker = true) as
  select p.id            as user_id,
         p.username,
         p.role,
         coalesce(m.enabled, false) as mfa_enabled,
         m.confirmed_at,
         coalesce(array_length(m.recovery_codes, 1), 0) as recovery_codes_left,
         p.site_id,
         p.platform_id,
         p.status
    from public.profiles p
    left join public.user_mfa m on m.user_id = p.id
   where p.role in ('admin', 'platform_admin', 'platform_superadmin');

comment on view public.v_mfa_status is
  'Issue 1 / F-48: 2FA enrolment of every operator tier (site admin, platform admin, system owner). service_role only.';

revoke all on public.v_mfa_status from public, anon, authenticated;
grant select on public.v_mfa_status to service_role;
