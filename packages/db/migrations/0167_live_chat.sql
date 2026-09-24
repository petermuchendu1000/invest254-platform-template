-- 0167_live_chat.sql — CHAT-1: human live chat between a signed-in player and the brand's support
-- agents (brand admins, their platform admins, the System owner), with photo / short-video / voice
-- attachments. Also the brand's WhatsApp support number (shown in chat and the account menu).
--
-- Separate from the 0057 AI assistant (support_conversations): a live thread belongs to exactly one
-- player and brand, and agents answer it in the back office.
--
-- INVARIANTS (packages/db/_testkit/e2e_live_chat.py):
--   1. At most one OPEN thread per player (a new message after "resolved" opens a fresh one).
--   2. Every message and attachment carries its thread's site_id (brand scoping for agents).
--   3. Attachments: allowed MIME types only; image <= 5 MB, video <= 15 MB, audio <= 3 MB.
--   4. Unread counters: a player message bumps agent_unread; an agent message bumps player_unread;
--      mark-read zeroes the reader's counter.
--   5. Only the service_role (the API) may call the RPCs; RLS keeps everything else out.
-- Additive + idempotent.

begin;

alter table public.sites add column if not exists support_whatsapp text
  check (support_whatsapp is null or support_whatsapp ~ '^\+?[0-9]{7,15}$');

create table if not exists public.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  status          text not null default 'open' check (status in ('open','resolved')),
  player_unread   int  not null default 0,
  agent_unread    int  not null default 0,
  last_message_at timestamptz not null default now(),
  last_preview    text,
  resolved_by     uuid references public.profiles(id),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_chat_threads_open on public.chat_threads(user_id) where status = 'open';
create index if not exists idx_chat_threads_site on public.chat_threads(site_id, status, last_message_at desc);

create table if not exists public.chat_attachments (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.chat_threads(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  uploader_id uuid not null references public.profiles(id),
  kind        text not null check (kind in ('image','video','audio')),
  mime        text not null,
  size_bytes  int  not null,
  data        bytea not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_chat_attachments_thread on public.chat_attachments(thread_id);

create table if not exists public.chat_messages (
  id            bigserial primary key,
  thread_id     uuid not null references public.chat_threads(id) on delete cascade,
  site_id       uuid not null references public.sites(id) on delete cascade,
  author_role   text not null check (author_role in ('player','agent','system')),
  author_id     uuid references public.profiles(id),
  body          text not null default '' check (length(body) <= 4000),
  attachment_id uuid references public.chat_attachments(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_chat_messages_thread on public.chat_messages(thread_id, id);

alter table public.chat_threads     enable row level security;
alter table public.chat_messages    enable row level security;
alter table public.chat_attachments enable row level security;

-- The player's open thread, created on demand.
create or replace function public.fn_chat_open_thread(p_user uuid, p_site uuid)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_user and site_id = p_site) then raise exception 'NOT_YOUR_BRAND'; end if;
  select id into v_id from chat_threads where user_id = p_user and status = 'open';
  if found then return v_id; end if;
  insert into chat_threads(site_id, user_id) values (p_site, p_user)
    on conflict (user_id) where status = 'open' do nothing
    returning id into v_id;
  if v_id is null then select id into v_id from chat_threads where user_id = p_user and status = 'open'; end if;
  return v_id;
end $fn$;

-- Store an attachment (size + type checked here, whatever the caller did).
create or replace function public.fn_chat_attach(p_thread uuid, p_uploader uuid, p_mime text, p_data bytea)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; v_kind text; v_size int := octet_length(p_data); v_id uuid;
begin
  select site_id into v_site from chat_threads where id = p_thread;
  if not found then raise exception 'THREAD_NOT_FOUND'; end if;
  v_kind := case
    when p_mime in ('image/jpeg','image/png','image/webp','image/gif') then 'image'
    when p_mime in ('video/mp4','video/webm','video/quicktime') then 'video'
    when p_mime in ('audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav') then 'audio'
    else null end;
  if v_kind is null then raise exception 'UNSUPPORTED_FILE'; end if;
  if v_size = 0 then raise exception 'EMPTY_FILE'; end if;
  if (v_kind = 'image' and v_size > 5242880) or (v_kind = 'video' and v_size > 15728640) or (v_kind = 'audio' and v_size > 3145728) then
    raise exception 'FILE_TOO_LARGE';
  end if;
  insert into chat_attachments(thread_id, site_id, uploader_id, kind, mime, size_bytes, data)
    values (p_thread, v_site, p_uploader, v_kind, p_mime, v_size, p_data) returning id into v_id;
  return v_id;
end $fn$;

-- Post a message (text and/or one attachment). Agents posting to a resolved thread reopen it.
create or replace function public.fn_chat_post(p_thread uuid, p_role text, p_author uuid, p_body text, p_attachment uuid)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; v_status text; v_id bigint; v_body text := btrim(coalesce(p_body, '')); v_preview text;
begin
  if p_role not in ('player','agent','system') then raise exception 'INVALID_ROLE'; end if;
  select site_id, status into v_site, v_status from chat_threads where id = p_thread for update;
  if not found then raise exception 'THREAD_NOT_FOUND'; end if;
  if v_body = '' and p_attachment is null then raise exception 'EMPTY_MESSAGE'; end if;
  if length(v_body) > 4000 then raise exception 'MESSAGE_TOO_LONG'; end if;
  if p_attachment is not null and not exists (select 1 from chat_attachments where id = p_attachment and thread_id = p_thread) then
    raise exception 'ATTACHMENT_NOT_FOUND';
  end if;
  if v_status = 'resolved' and p_role = 'player' then raise exception 'THREAD_CLOSED'; end if;
  if v_status = 'resolved' and p_role = 'agent'
     and exists (select 1 from chat_threads t2 where t2.user_id = (select user_id from chat_threads where id = p_thread) and t2.status = 'open') then
    raise exception 'PLAYER_HAS_OPEN_THREAD';
  end if;
  insert into chat_messages(thread_id, site_id, author_role, author_id, body, attachment_id)
    values (p_thread, v_site, p_role, p_author, v_body, p_attachment) returning id into v_id;
  v_preview := case when v_body <> '' then left(v_body, 140)
                    else (select '[' || kind || ']' from chat_attachments where id = p_attachment) end;
  update chat_threads set
      last_message_at = now(), last_preview = v_preview,
      agent_unread  = agent_unread  + case when p_role = 'player' then 1 else 0 end,
      player_unread = player_unread + case when p_role = 'agent'  then 1 else 0 end,
      status = case when p_role = 'agent' then 'open' else status end,
      resolved_at = case when p_role = 'agent' then null else resolved_at end,
      resolved_by = case when p_role = 'agent' then null else resolved_by end
    where id = p_thread;
  return v_id;
end $fn$;

create or replace function public.fn_chat_mark_read(p_thread uuid, p_reader text)
returns void language sql security definer set search_path = public as $fn$
  update chat_threads set
      player_unread = case when p_reader = 'player' then 0 else player_unread end,
      agent_unread  = case when p_reader = 'agent'  then 0 else agent_unread  end
    where id = p_thread;
$fn$;

-- Resolve / reopen (agents). A system line records it in the thread.
create or replace function public.fn_chat_set_status(p_thread uuid, p_actor uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; v_user uuid; v_cur text;
begin
  if p_status not in ('open','resolved') then raise exception 'INVALID_STATUS'; end if;
  select site_id, user_id, status into v_site, v_user, v_cur from chat_threads where id = p_thread for update;
  if not found then raise exception 'THREAD_NOT_FOUND'; end if;
  if v_cur = p_status then return; end if;
  if p_status = 'open' and exists (select 1 from chat_threads where user_id = v_user and status = 'open') then
    raise exception 'PLAYER_HAS_OPEN_THREAD';
  end if;
  update chat_threads set status = p_status,
      resolved_at = case when p_status = 'resolved' then now() else null end,
      resolved_by = case when p_status = 'resolved' then p_actor else null end,
      agent_unread = case when p_status = 'resolved' then 0 else agent_unread end
    where id = p_thread;
  insert into chat_messages(thread_id, site_id, author_role, author_id, body)
    values (p_thread, v_site, 'system', p_actor, case when p_status = 'resolved' then 'Conversation marked as resolved.' else 'Conversation reopened.' end);
end $fn$;

-- Retention: attachments older than p_days are removed (their messages keep a placeholder).
create or replace function public.fn_chat_prune_attachments(p_days int default 90)
returns int language sql security definer set search_path = public as $fn$
  with d as (delete from chat_attachments where created_at < now() - make_interval(days => greatest(p_days, 7)) returning 1)
  select count(*)::int from d;
$fn$;

do $g$
declare f text;
begin
  foreach f in array array[
    'fn_chat_open_thread(uuid,uuid)', 'fn_chat_attach(uuid,uuid,text,bytea)', 'fn_chat_post(uuid,text,uuid,text,uuid)',
    'fn_chat_mark_read(uuid,text)', 'fn_chat_set_status(uuid,uuid,text)', 'fn_chat_prune_attachments(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$g$;

-- The brand's WhatsApp support number is editable through the same audited site patch (0134 + one line).
create or replace function public.fn_platform_update_site(p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb)
 returns sites language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.sites; v_before jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  select to_jsonb(s) into v_before from public.sites s where s.id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;
  perform public.fn_platform_site_in_scope(p_actor, p_actor_role, p_site_id);

  update public.sites u set
    name           = case when p_patch ? 'name'           then btrim(p_patch->>'name')          else u.name end,
    primary_domain = case when p_patch ? 'primary_domain' then nullif(btrim(p_patch->>'primary_domain'),'') else u.primary_domain end,
    logo_url       = case when p_patch ? 'logo_url'       then nullif(p_patch->>'logo_url','')  else u.logo_url end,
    favicon_url    = case when p_patch ? 'favicon_url'    then nullif(p_patch->>'favicon_url','') else u.favicon_url end,
    wordmark_text  = case when p_patch ? 'wordmark_text'  then nullif(p_patch->>'wordmark_text','') else u.wordmark_text end,
    color_primary  = case when p_patch ? 'color_primary'  then p_patch->>'color_primary'        else u.color_primary end,
    color_bg       = case when p_patch ? 'color_bg'       then p_patch->>'color_bg'             else u.color_bg end,
    color_accent   = case when p_patch ? 'color_accent'   then p_patch->>'color_accent'         else u.color_accent end,
    theme          = case when p_patch ? 'theme'          then p_patch->>'theme'                else u.theme end,
    currency       = case when p_patch ? 'currency'       then p_patch->>'currency'             else u.currency end,
    locale         = case when p_patch ? 'locale'         then p_patch->>'locale'               else u.locale end,
    chart_style    = case when p_patch ? 'chart_style'    then p_patch->>'chart_style'          else u.chart_style end,
    trade_ui       = case when p_patch ? 'trade_ui'       then p_patch->>'trade_ui'             else u.trade_ui end,
    licence_line   = case when p_patch ? 'licence_line'   then nullif(p_patch->>'licence_line','') else u.licence_line end,
    support_email  = case when p_patch ? 'support_email'  then nullif(p_patch->>'support_email','') else u.support_email end,
    support_whatsapp = case when p_patch ? 'support_whatsapp' then nullif(regexp_replace(coalesce(p_patch->>'support_whatsapp',''), '[\s()-]', '', 'g'),'') else u.support_whatsapp end,
    status         = case when p_patch ? 'status'         then p_patch->>'status'               else u.status end,
    mpesa_env           = case when p_patch ? 'mpesa_env'            then nullif(p_patch->>'mpesa_env','')            else u.mpesa_env end,
    mpesa_shortcode     = case when p_patch ? 'mpesa_shortcode'      then nullif(p_patch->>'mpesa_shortcode','')      else u.mpesa_shortcode end,
    mpesa_callback_base = case when p_patch ? 'mpesa_callback_base'  then nullif(p_patch->>'mpesa_callback_base','')  else u.mpesa_callback_base end,
    mpesa_b2c_initiator = case when p_patch ? 'mpesa_b2c_initiator'  then nullif(p_patch->>'mpesa_b2c_initiator','')  else u.mpesa_b2c_initiator end,
    legal_copy          = case when p_patch ? 'legal_copy'           then p_patch->'legal_copy'                       else u.legal_copy end,
    updated_at     = now()
  where u.id = p_site_id
  returning * into v_row;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.update', 'site', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)));
  return v_row;
end;
$function$;

commit;
