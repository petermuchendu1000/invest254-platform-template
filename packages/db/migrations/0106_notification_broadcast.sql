-- 0106_notification_broadcast.sql — reusable system-notification library + one-call broadcast engine.
--
-- WHY: operators need to alert everyone (or only the users affected by an incident) in one action,
-- and to clear that alert platform-wide when it is over. Until now notifications were per-user rows
-- with no template store and no broadcast/resolve helper (the API bulk-notify took an explicit
-- userIds list). This migration adds:
--   (1) notification_templates — a saved, editable library of the standard system messages
--       (deposits down/restored, withdrawals down/restored, delays, maintenance, security, etc.).
--   (2) fn_notification_audience(jsonb) — resolves a target audience from a small filter spec:
--         { "status":"active", "roles":[...], "sites":[uuid...],
--           "affected_within_hours": 24, "affected_kind":"deposit"|"withdrawal" }
--       When affected_within_hours is set, it targets ONLY users who had a FAILED payment of that
--       kind in the window — this is the "select all affected with one click" audience.
--   (3) fn_notification_audience_count(jsonb) — the live recipient count for a preview before sending.
--   (4) fn_broadcast_notification(actor, actor_role, template_key, audience) — inserts one row per
--       matched user (idempotent: never a second ACTIVE notice of the same category per user),
--       optionally resolves the incident category a "restored" template supersedes, audits, returns count.
--   (5) fn_resolve_notifications_by_category(actor, actor_role, category) — clears an active category
--       platform-wide in one call (the "issue is over" button).
--
-- All helpers are admin+ only and SECURITY DEFINER. Additive and idempotent (safe to re-apply).

-- ── (1) Template library ───────────────────────────────────────────────────────────────────────
create table if not exists public.notification_templates (
  key               text primary key,
  level             text not null default 'info' check (level in ('info','success','warning','error')),
  title             text not null check (length(title) between 1 and 120),
  body              text not null default '' check (length(body) <= 1000),
  dismissible       boolean not null default true,
  category          text not null,                 -- machine tag on each sent notice (idempotency + resolve)
  resolves_category text,                           -- when broadcast, first clears this category (restored notices)
  default_audience  jsonb not null default '{"status":"active"}'::jsonb,
  active            boolean not null default true,
  description       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── (2) Audience resolver ──────────────────────────────────────────────────────────────────────
create or replace function public.fn_notification_audience(p_audience jsonb)
returns table(user_id uuid, site_id uuid)
language sql stable set search_path = public as $fn$
  select p.id, p.site_id
  from public.profiles p
  where p.status = coalesce(nullif(p_audience->>'status',''), 'active')
    -- only ever real people-facing roles
    and p.role in ('player','marketer','admin','superadmin','super_admin','platform_superadmin')
    -- optional explicit role filter
    and ( not (p_audience ? 'roles')
          or p.role in (select jsonb_array_elements_text(p_audience->'roles')) )
    -- optional brand/site filter
    and ( not (p_audience ? 'sites')
          or p.site_id in (select (jsonb_array_elements_text(p_audience->'sites'))::uuid) )
    -- optional "affected only": users with a FAILED payment of the given kind within the window
    and ( not (p_audience ? 'affected_within_hours')
          or p.id in (
            select t.user_id from public.transactions t
            where t.kind = coalesce(nullif(p_audience->>'affected_kind',''), 'deposit')
              and t.status = 'failed'
              and t.created_at > now() - (greatest((p_audience->>'affected_within_hours')::int, 0) * interval '1 hour')
          ) );
$fn$;

create or replace function public.fn_notification_audience_count(p_audience jsonb)
returns integer language sql stable set search_path = public as $fn$
  select count(*)::int from public.fn_notification_audience(coalesce(p_audience, '{}'::jsonb));
$fn$;

-- ── (3) Broadcast a template to an audience (idempotent, audited) ───────────────────────────────
create or replace function public.fn_broadcast_notification(
  p_actor uuid, p_actor_role text, p_template_key text, p_audience jsonb default null
) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_tmpl public.notification_templates; v_aud jsonb; v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  select * into v_tmpl from public.notification_templates where key = p_template_key and active;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;

  v_aud := coalesce(p_audience, v_tmpl.default_audience, '{}'::jsonb);

  -- A "restored/complete" template clears the incident banners it supersedes first.
  if v_tmpl.resolves_category is not null then
    update public.user_notifications set resolved_at = now()
      where category = v_tmpl.resolves_category
        and dismissed_at is null and resolved_at is null;
  end if;

  with ins as (
    insert into public.user_notifications
      (user_id, level, title, body, dismissible, category, created_by, site_id)
    select a.user_id, v_tmpl.level, v_tmpl.title, v_tmpl.body, v_tmpl.dismissible, v_tmpl.category, p_actor, a.site_id
    from public.fn_notification_audience(v_aud) a
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
                               'level', v_tmpl.level, 'audience', v_aud));
  return v_count;
end;
$fn$;

-- ── (4) Resolve (clear) an active category platform-wide ───────────────────────────────────────
create or replace function public.fn_resolve_notifications_by_category(
  p_actor uuid, p_actor_role text, p_category text
) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_count int := 0;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  update public.user_notifications set resolved_at = now()
    where category = p_category and dismissed_at is null and resolved_at is null;
  get diagnostics v_count = row_count;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'notification.resolve_category', 'category', p_category,
            jsonb_build_object('cleared', v_count));
  return v_count;
end;
$fn$;

-- ── (5) Seed the standard system-notification library ──────────────────────────────────────────
-- No em dashes. Plain, human, professional, scam-aware. Bodies are editable by admins later.
insert into public.notification_templates (key, level, title, body, dismissible, category, resolves_category, default_audience, description) values
('deposits_down','warning','M-Pesa deposits temporarily unavailable',
 'M-Pesa deposits are currently affected by a temporary issue on Safaricom''s network. If your deposit did not go through, please be assured that no money was deducted and your account balance is safe. This is a network problem on Safaricom''s side, not a problem with your account or with us. Our team is in touch with Safaricom to restore deposits as soon as possible. Please try again later. We will remove this notice once deposits are working normally again. Thank you for your patience.',
 true,'deposits_incident',null,'{"status":"active"}','Deposit outage (M-Pesa/Safaricom).'),
('deposits_restored','success','M-Pesa deposits are working again',
 'Good news. M-Pesa deposits are now working normally again. Thank you for your patience while the issue on Safaricom''s network was resolved. You can top up your account as usual. If an earlier attempt failed, no money was taken, so please go ahead and try again.',
 true,'deposits_restored','deposits_incident','{"status":"active"}','Deposits restored (clears the deposit outage notice).'),
('withdrawals_down','warning','Withdrawals are temporarily delayed',
 'Withdrawals are currently delayed because of a temporary issue on Safaricom''s M-Pesa network. Your funds are safe. Any withdrawal you have requested will be sent automatically as soon as service is restored, so you do not need to request it again. Thank you for your patience.',
 true,'withdrawals_incident',null,'{"status":"active"}','Withdrawal outage/delay.'),
('withdrawals_restored','success','Withdrawals are back to normal',
 'Withdrawals are now processing normally again. Any withdrawal that was pending during the delay has been released. Thank you for your patience.',
 true,'withdrawals_restored','withdrawals_incident','{"status":"active"}','Withdrawals restored (clears the withdrawal notice).'),
('payments_delayed','info','M-Pesa transactions may be slower than usual',
 'M-Pesa deposits and withdrawals may take a little longer than usual right now due to delays on Safaricom''s network. Your money is safe. If a deposit does not reflect immediately, please wait a few minutes before trying again. No money is deducted for a deposit that does not go through.',
 true,'payments_delay',null,'{"status":"active"}','General M-Pesa slowness (deposits and withdrawals).'),
('scheduled_maintenance','warning','Scheduled maintenance',
 'We will be carrying out brief scheduled maintenance to improve the platform. During this time some features may be unavailable for a short period. Your account and balance are safe. We will restore full service as quickly as possible and remove this notice once we are done. Thank you for your understanding.',
 true,'maintenance',null,'{"status":"active"}','Planned maintenance window.'),
('maintenance_complete','success','Maintenance complete',
 'Scheduled maintenance is complete and all features are available again. Thank you for your patience.',
 true,'maintenance_done','maintenance','{"status":"active"}','Maintenance finished (clears the maintenance notice).'),
('service_disruption','warning','We are looking into a service issue',
 'We are aware of a technical issue affecting part of the platform and our team is working on it right now. Your account and balance are safe. We will remove this notice as soon as the issue is resolved. Thank you for your patience.',
 true,'service_incident',null,'{"status":"active"}','General service disruption.'),
('service_restored','success','Service restored',
 'The technical issue has been resolved and the platform is fully back to normal. Thank you for your patience.',
 true,'service_restored','service_incident','{"status":"active"}','Service restored (clears the disruption notice).'),
('security_notice','warning','Protect your account and your money',
 'Please keep your account safe. We will never call, text, or message you to ask for your password, your M-Pesa PIN, or a one time code. Never share these with anyone, even someone who claims to be from our team. If someone asks you for your PIN or a code, it is a scam. When in doubt, do not share anything and contact our official support.',
 true,'security_notice',null,'{"status":"active"}','Anti-scam / phishing safety reminder.'),
('announcement','info','Announcement',
 'We have an update to share with you. Please check your account for details.',
 true,'announcement',null,'{"status":"active"}','Generic announcement. Edit the title and body before sending.')
on conflict (key) do update set
  level=excluded.level, title=excluded.title, body=excluded.body, dismissible=excluded.dismissible,
  category=excluded.category, resolves_category=excluded.resolves_category,
  default_audience=excluded.default_audience, description=excluded.description, updated_at=now();
