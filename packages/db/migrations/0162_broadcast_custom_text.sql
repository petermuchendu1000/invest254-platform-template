-- 0162_broadcast_custom_text.sql — UI-C (docs/44): an announcement's title and body can be edited before sending.
--
-- The Announcements page offers an "Announcement" template described as "Generic announcement. Edit the title
-- and body before sending", but fn_broadcast_notification could only send a template verbatim, so a brand
-- admin would have sent "We have an update to share with you…" to every player. This adds optional
-- p_title / p_body that override the template text (trimmed; blank = the template's own text; bounded), and
-- records in the audit trail that the text was edited. Everything else — authorization, actor-scoped
-- audience (0141/0156), idempotency per user+category, resolves_category — is byte-for-byte the 0156 body.
--
-- DEPLOY-ORDER SAFE: the 4-argument signature is replaced by one 6-argument function whose two new
-- parameters default to NULL, so the currently deployed API (4 arguments) keeps working unchanged.
-- Replaced (not overloaded) so a 4-argument call can never be ambiguous. Idempotent.

drop function if exists public.fn_broadcast_notification(uuid, text, text, jsonb);

create or replace function public.fn_broadcast_notification(
  p_actor uuid, p_actor_role text, p_template_key text, p_audience jsonb default null,
  p_title text default null, p_body text default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tmpl public.notification_templates; v_aud jsonb; v_count int := 0;
        v_title text; v_body text; v_custom boolean;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  select * into v_tmpl from public.notification_templates where key = p_template_key and active;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_body  := nullif(btrim(coalesce(p_body, '')), '');
  if v_title is not null and length(v_title) > 120 then raise exception 'TITLE_TOO_LONG'; end if;
  if v_body is not null and length(v_body) > 2000 then raise exception 'BODY_TOO_LONG'; end if;
  v_custom := v_title is not null or v_body is not null;
  v_title := coalesce(v_title, v_tmpl.title);
  v_body  := coalesce(v_body, v_tmpl.body);

  v_aud := coalesce(p_audience, v_tmpl.default_audience, '{}'::jsonb);

  -- A "restored/complete" template clears the incident banners it supersedes first — but ONLY within
  -- the caller's own sites (a site admin must not clear another brand's banners).
  if v_tmpl.resolves_category is not null then
    update public.user_notifications set resolved_at = now()
      where category = v_tmpl.resolves_category
        and dismissed_at is null and resolved_at is null
        and site_id in (select fas.site_id from public.fn_actor_bulk_sites(p_actor, p_actor_role, v_aud) fas);
  end if;

  with ins as (
    insert into public.user_notifications
      (user_id, level, title, body, dismissible, category, created_by, site_id)
    select a.user_id, v_tmpl.level, v_title, v_body, v_tmpl.dismissible, v_tmpl.category, p_actor, a.site_id
    from public.fn_notification_audience_scoped(p_actor, p_actor_role, v_aud) a
    where not exists (
      select 1 from public.user_notifications n
      where n.user_id = a.user_id and n.category = v_tmpl.category
        and n.dismissed_at is null and n.resolved_at is null
    )
    returning 1
  )
  select count(*)::int into v_count from ins;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.broadcast', 'template', p_template_key,
            jsonb_build_object('recipients', v_count, 'category', v_tmpl.category,
                               'level', v_tmpl.level, 'audience', v_aud,
                               'custom_text', v_custom, 'title', v_title));
  return v_count;
end;
$function$;

revoke all on function public.fn_broadcast_notification(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.fn_broadcast_notification(uuid, text, text, jsonb, text, text) to service_role;
