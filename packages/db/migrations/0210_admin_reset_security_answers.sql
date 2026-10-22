-- 0210_admin_reset_security_answers.sql — let a platform operator clear a SUBORDINATE's security
-- answers, so a locked-out colleague can enrol a fresh set.
--
-- THE PROBLEM. Security answers (0097) are a knowledge factor with no recovery path: they are stored
-- scrypt-hashed and are never readable, so an operator who forgets them is permanently blocked from
-- whatever they gate. For a SITE ADMIN that is the step-up factor itself (apps/api/src/stepup.ts
-- asks knowledge of a site admin, possession of the platform tiers), which means every money action
-- in the back office. Until now the only remedy was a hand-written DELETE against production.
--
-- WHAT A RESET IS. Deleting the rows IS the reset: `securitySetupRequired` on /auth/me is computed
-- from the stored count, so emptying it flips that flag and SecurityQuestionsGate forces the person
-- to choose and answer three fresh questions at next load. No answer is ever moved, revealed or
-- chosen on their behalf — the operator running this cannot learn or set what the answers become.
--
-- NO DEADLOCK. `POST /api/v1/auth/security-questions` is step-up EXEMPT on both sides (the server
-- set in stepup.ts and the client list in lib/auth/stepUp.ts), so a person with no answers can still
-- set new ones. Everything else stays fail-closed: with nothing stored, step-up cannot be satisfied,
-- so gated actions are refused until the new set is in place.
--
-- WHO MAY RUN IT — the ladder is copied from fn_admin_set_user_status (0156), deliberately, because
-- a second factor is at least as sensitive as a ban:
--   * actor must be platform_admin or above. A SITE admin is refused outright: one site admin
--     clearing another's second factor is a lateral move inside the same tier, not supervision.
--   * p_actor = p_target is refused (NO_SELF_ACTION). This is the load-bearing one. Without it
--     anyone holding a live privileged session could drop their own knowledge factor and enrol a
--     new one, which turns "something you know" into "something your session can rewrite" and
--     defeats step-up entirely for the account most worth protecting.
--   * a platform_superadmin target is refused (SUPERADMIN_PROTECTED) — recovering the system owner
--     is a break-glass operation, not a button.
--   * a platform_admin target needs a platform_superadmin actor.
--   * a platform_admin actor is confined to its own platform (fn_user_platform), and every actor is
--     fenced to its brand scope by fn_assert_actor_site_scope.
--
-- SESSIONS ARE ENDED in the same transaction. Clearing the answers while a session is live would
-- leave that session inside its existing step-up window, still able to act with a factor that no
-- longer exists. Stamping profiles.sessions_valid_after (0097) forces re-authentication, so the
-- next thing the person meets is the setup gate.
--
-- Audited like every other actor-on-user RPC: one admin_actions row naming the actor, the target's
-- role and how many answers were discarded.
--
-- Scope: profiles only. The marketer app authenticates as a marketers.id with its own answers table
-- (marketer_security_answers, 0198) and its own fail-closed self-service reset; it is NOT touched
-- here. Undo: drop function.

begin;

create or replace function public.fn_admin_reset_security_answers(
  p_actor      uuid,
  p_actor_role text,
  p_target     uuid
)
returns table(user_id uuid, cleared int)
language plpgsql
security definer
set search_path to 'public'
as $func$
declare
  v_target_role     text;
  v_cleared         int;
  v_actor_platform  uuid;
  v_target_platform uuid;
begin
  -- DB-level brand fence (Issue 1 / F-46), first, as every other actor-on-user RPC does.
  perform public.fn_assert_actor_site_scope(p_actor, p_actor_role, (select site_id from public.profiles where id = p_target));

  if p_actor_role not in ('platform_admin','superadmin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_actor = p_target then
    raise exception 'NO_SELF_ACTION';
  end if;

  select pr.role into v_target_role from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  if v_target_role in ('superadmin','platform_superadmin') then
    raise exception 'SUPERADMIN_PROTECTED';
  end if;
  if v_target_role = 'platform_admin' and p_actor_role <> 'platform_superadmin' then
    raise exception 'INSUFFICIENT_PRIVILEGE';
  end if;

  -- A PLATFORM admin is confined to users inside ITS OWN platform.
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    v_target_platform := public.fn_user_platform(p_target);
    if v_target_platform is distinct from v_actor_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  end if;

  delete from public.user_security_answers where user_security_answers.user_id = p_target;
  get diagnostics v_cleared = row_count;

  -- Same transaction as the delete: a surviving session would otherwise keep acting inside a
  -- step-up window granted by a factor that no longer exists.
  update public.profiles pr set sessions_valid_after = now() where pr.id = p_target;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.reset_security_answers', 'user', p_target::text,
            jsonb_build_object('cleared', v_cleared, 'target_role', v_target_role));

  return query select p_target, v_cleared;
end;
$func$;

-- 0151 convention: an RPC is reachable by the service role only, never by anon/authenticated.
revoke all on function public.fn_admin_reset_security_answers(uuid, text, uuid) from public;
revoke all on function public.fn_admin_reset_security_answers(uuid, text, uuid) from anon;
revoke all on function public.fn_admin_reset_security_answers(uuid, text, uuid) from authenticated;

comment on function public.fn_admin_reset_security_answers(uuid, text, uuid) is
  'Clear a subordinate operator''s security answers (0097) and end their sessions, so they are '
  'forced to enrol a fresh set. platform_admin+ only; never self, never a superadmin target; a '
  'platform_admin is confined to its own platform. Audited to admin_actions. See docs/68.';

commit;
