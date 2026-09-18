-- 0139_tickets.sql — internal escalation ticketing (Issue 2).
--
-- An authorized admin raises a ticket with a reason + urgency. It is ASSIGNED to the platform admin
-- (escalation level 0); if unresolved past its urgency SLA it AUTO-ESCALATES to the System admin
-- (level 1). A platform admin who raises a ticket assigns it straight to the System admin. Every
-- escalation (auto or manual) is logged in ticket_escalations. Comments give a running thread.
-- Scope: a platform admin sees only its platform's tickets; a site admin sees its own; system sees all.
-- SLAs come from ops_config (tunable). Notifications land in user_notifications for the assignee tier.

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.tickets (
  id                uuid primary key default gen_random_uuid(),
  platform_id       uuid not null references public.platforms(id) on delete cascade,
  site_id           uuid references public.sites(id),
  created_by        uuid not null references public.profiles(id),
  created_by_role   text not null,
  subject           text not null check (length(subject) between 1 and 200),
  body              text not null default '' check (length(body) <= 5000),
  urgency           text not null check (urgency in ('low','medium','high','critical')),
  status            text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  escalation_level  int  not null default 0,          -- 0 = platform admin, 1 = system admin
  assignee_role     text not null default 'platform_admin' check (assignee_role in ('platform_admin','platform_superadmin')),
  sla_due_at        timestamptz,                       -- when level-0 auto-escalates (null at top)
  first_response_at timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_tickets_platform on public.tickets(platform_id, status);
create index if not exists idx_tickets_sla on public.tickets(status, escalation_level, sla_due_at);
create index if not exists idx_tickets_creator on public.tickets(created_by);

create table if not exists public.ticket_escalations (
  id         bigserial primary key,
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  from_level int not null, to_level int not null,
  from_role  text, to_role text,
  reason     text not null check (reason in ('auto','manual')),
  note       text,
  actor_id   uuid,                                     -- null = automatic
  actor_role text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ticket_escalations_ticket on public.ticket_escalations(ticket_id, created_at);

create table if not exists public.ticket_comments (
  id          bigserial primary key,
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  author_id   uuid not null references public.profiles(id),
  author_role text not null,
  body        text not null check (length(body) between 1 and 5000),
  created_at  timestamptz not null default now()
);
create index if not exists idx_ticket_comments_ticket on public.ticket_comments(ticket_id, created_at);

-- ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_ticket_sla_due(p_urgency text, p_from timestamptz)
returns timestamptz language sql stable set search_path = public as $$
  select p_from + make_interval(mins => (
    select case p_urgency
             when 'critical' then ticket_sla_critical_mins
             when 'high'     then ticket_sla_high_mins
             when 'medium'   then ticket_sla_medium_mins
             else                 ticket_sla_low_mins end
      from public.ops_config where id))
$$;

-- Raise unless the actor may access the ticket (system=all; platform_admin=own platform; site admin=own).
create or replace function public.fn_ticket_in_scope(p_actor uuid, p_actor_role text, p_ticket uuid)
returns void language plpgsql stable set search_path = public as $fn$
declare v_platform uuid; v_creator uuid; v_actor_platform uuid;
begin
  select platform_id, created_by into v_platform, v_creator from public.tickets where id = p_ticket;
  if not found then raise exception 'TICKET_NOT_FOUND'; end if;
  if p_actor_role = 'platform_superadmin' then return; end if;
  if p_actor_role = 'platform_admin' then
    select platform_id into v_actor_platform from public.profiles where id = p_actor;
    if v_actor_platform is not null and v_actor_platform = v_platform then return; end if;
    raise exception 'PLATFORM_SCOPE_FORBIDDEN';
  end if;
  if p_actor_role = 'admin' and v_creator = p_actor then return; end if;
  raise exception 'NOT_AUTHORIZED';
end;
$fn$;

-- Notify the assignee tier: platform admins of the platform, or all system admins.
create or replace function public.fn_ticket_notify(p_ticket uuid, p_target_role text, p_title text, p_level text default 'warning')
returns void language plpgsql security definer set search_path = public as $fn$
declare v_platform uuid; v_subject text;
begin
  select platform_id, subject into v_platform, v_subject from public.tickets where id = p_ticket;
  insert into public.user_notifications (user_id, level, title, body, category, site_id)
  select pr.id, p_level, p_title, left(v_subject, 200), 'ticket', pr.site_id
    from public.profiles pr
   where (p_target_role = 'platform_admin'      and pr.role='platform_admin' and pr.platform_id = v_platform)
      or (p_target_role = 'platform_superadmin' and pr.role='platform_superadmin');
end;
$fn$;

-- ── Create a ticket ──────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_ticket_create(
  p_actor uuid, p_actor_role text, p_platform uuid, p_site uuid, p_subject text, p_body text, p_urgency text
) returns public.tickets
language plpgsql security definer set search_path = public as $fn$
declare v_row public.tickets; v_platform uuid; v_site uuid; v_level int; v_assignee text;
begin
  if p_actor_role not in ('admin','platform_admin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(btrim(p_subject),'') = '' then raise exception 'INVALID_SUBJECT'; end if;
  if p_urgency not in ('low','medium','high','critical') then raise exception 'INVALID_URGENCY'; end if;

  if p_actor_role = 'admin' then
    select site_id into v_site from public.profiles where id = p_actor;
    v_platform := (select platform_id from public.sites where id = v_site);
    v_level := 0;                                   -- -> assigned to the platform admin
  elsif p_actor_role = 'platform_admin' then
    select platform_id into v_platform from public.profiles where id = p_actor;
    if v_platform is null then raise exception 'NOT_AUTHORIZED'; end if;
    if p_site is not null then
      if (select platform_id from public.sites where id = p_site) is distinct from v_platform then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
      v_site := p_site;
    end if;
    v_level := 1;                                   -- a platform admin escalates straight to the System admin
  else -- platform_superadmin
    if p_platform is null then raise exception 'INVALID_PLATFORM'; end if;
    if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
    v_platform := p_platform; v_site := p_site; v_level := 0;
  end if;

  v_assignee := case when v_level = 0 then 'platform_admin' else 'platform_superadmin' end;
  insert into public.tickets (platform_id, site_id, created_by, created_by_role, subject, body, urgency,
                              escalation_level, assignee_role, sla_due_at)
    values (v_platform, v_site, p_actor, p_actor_role, btrim(p_subject), coalesce(p_body,''), p_urgency,
            v_level, v_assignee, case when v_level=0 then public.fn_ticket_sla_due(p_urgency, now()) else null end)
    returning * into v_row;

  perform public.fn_ticket_notify(v_row.id, v_assignee,
    'New '||upper(p_urgency)||' ticket: '||btrim(p_subject),
    case p_urgency when 'critical' then 'error' when 'high' then 'warning' else 'info' end);
  return v_row;
end;
$fn$;

-- ── Comment ──────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_ticket_add_comment(p_actor uuid, p_actor_role text, p_ticket uuid, p_body text)
returns public.ticket_comments
language plpgsql security definer set search_path = public as $fn$
declare v_row public.ticket_comments; v_creator uuid; v_assignee text;
begin
  perform public.fn_ticket_in_scope(p_actor, p_actor_role, p_ticket);
  if coalesce(btrim(p_body),'') = '' then raise exception 'INVALID_BODY'; end if;
  select created_by, assignee_role into v_creator, v_assignee from public.tickets where id = p_ticket;
  insert into public.ticket_comments (ticket_id, author_id, author_role, body)
    values (p_ticket, p_actor, p_actor_role, btrim(p_body)) returning * into v_row;
  -- Mark first assignee response.
  update public.tickets set first_response_at = coalesce(first_response_at, now()), updated_at = now()
    where id = p_ticket and p_actor <> v_creator;
  -- Notify the other side.
  if p_actor = v_creator then perform public.fn_ticket_notify(p_ticket, v_assignee, 'Ticket updated by requester', 'info');
  else insert into public.user_notifications (user_id, level, title, body, category, site_id)
       select v_creator, 'info', 'Your ticket was updated', left(btrim(p_body),200), 'ticket', pr.site_id
         from public.profiles pr where pr.id = v_creator;
  end if;
  return v_row;
end;
$fn$;

-- ── Status ───────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_ticket_set_status(p_actor uuid, p_actor_role text, p_ticket uuid, p_status text, p_note text default null)
returns public.tickets
language plpgsql security definer set search_path = public as $fn$
declare v_row public.tickets; v_creator uuid;
begin
  perform public.fn_ticket_in_scope(p_actor, p_actor_role, p_ticket);
  if p_status not in ('open','in_progress','resolved','closed') then raise exception 'INVALID_STATUS'; end if;
  select created_by into v_creator from public.tickets where id = p_ticket;
  update public.tickets t set
    status = p_status,
    resolved_at = case when p_status='resolved' then now() when p_status in ('open','in_progress') then null else t.resolved_at end,
    resolved_by = case when p_status='resolved' then p_actor when p_status in ('open','in_progress') then null else t.resolved_by end,
    closed_at   = case when p_status='closed' then now() else t.closed_at end,
    updated_at  = now()
  where t.id = p_ticket returning * into v_row;
  if p_note is not null and btrim(p_note) <> '' then
    insert into public.ticket_comments (ticket_id, author_id, author_role, body)
      values (p_ticket, p_actor, p_actor_role, '['||p_status||'] '||btrim(p_note));
  end if;
  -- Tell the requester when their ticket is resolved/closed.
  if p_status in ('resolved','closed') and p_actor <> v_creator then
    insert into public.user_notifications (user_id, level, title, body, category, site_id)
    select v_creator, 'success', 'Your ticket was '||p_status, left(coalesce(p_note,''),200), 'ticket', pr.site_id
      from public.profiles pr where pr.id = v_creator;
  end if;
  return v_row;
end;
$fn$;

-- ── Manual escalation (level 0 -> 1) ─────────────────────────────────────────────────────────────
create or replace function public.fn_ticket_escalate(p_actor uuid, p_actor_role text, p_ticket uuid, p_note text default null)
returns public.tickets
language plpgsql security definer set search_path = public as $fn$
declare v_row public.tickets; v_level int;
begin
  perform public.fn_ticket_in_scope(p_actor, p_actor_role, p_ticket);
  select escalation_level into v_level from public.tickets where id = p_ticket for update;
  if v_level >= 1 then raise exception 'ALREADY_AT_TOP_LEVEL'; end if;
  update public.tickets set escalation_level = 1, assignee_role = 'platform_superadmin',
         status = case when status='open' then 'in_progress' else status end,
         sla_due_at = null, updated_at = now()
    where id = p_ticket returning * into v_row;
  insert into public.ticket_escalations (ticket_id, from_level, to_level, from_role, to_role, reason, note, actor_id, actor_role)
    values (p_ticket, 0, 1, 'platform_admin', 'platform_superadmin', 'manual', p_note, p_actor, p_actor_role);
  perform public.fn_ticket_notify(p_ticket, 'platform_superadmin', 'Ticket escalated to you', 'warning');
  return v_row;
end;
$fn$;

-- ── Cron: auto-escalate overdue level-0 tickets to the System admin ──────────────────────────────
create or replace function public.fn_ticket_auto_escalate()
returns integer language plpgsql security definer set search_path = public as $fn$
declare v_n int; r record;
begin
  v_n := 0;
  for r in
    update public.tickets set escalation_level = 1, assignee_role = 'platform_superadmin',
           status = case when status='open' then 'in_progress' else status end,
           sla_due_at = null, updated_at = now()
    where status in ('open','in_progress') and escalation_level = 0
      and sla_due_at is not null and sla_due_at < now()
    returning id, platform_id
  loop
    insert into public.ticket_escalations (ticket_id, from_level, to_level, from_role, to_role, reason, note)
      values (r.id, 0, 1, 'platform_admin', 'platform_superadmin', 'auto', 'SLA breached');
    perform public.fn_ticket_notify(r.id, 'platform_superadmin', 'Ticket auto-escalated (SLA breached)', 'error');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;

-- ── Grants: all ticket RPCs are service_role (the API holds the connection) ──────────────────────
do $g$
begin
  revoke all on function public.fn_ticket_create(uuid,text,uuid,uuid,text,text,text)  from public, anon, authenticated;
  revoke all on function public.fn_ticket_add_comment(uuid,text,uuid,text)            from public, anon, authenticated;
  revoke all on function public.fn_ticket_set_status(uuid,text,uuid,text,text)        from public, anon, authenticated;
  revoke all on function public.fn_ticket_escalate(uuid,text,uuid,text)               from public, anon, authenticated;
  revoke all on function public.fn_ticket_auto_escalate()                             from public, anon, authenticated;
  grant execute on function public.fn_ticket_create(uuid,text,uuid,uuid,text,text,text) to service_role;
  grant execute on function public.fn_ticket_add_comment(uuid,text,uuid,text)           to service_role;
  grant execute on function public.fn_ticket_set_status(uuid,text,uuid,text,text)       to service_role;
  grant execute on function public.fn_ticket_escalate(uuid,text,uuid,text)              to service_role;
  grant execute on function public.fn_ticket_auto_escalate()                            to service_role;
end
$g$;
