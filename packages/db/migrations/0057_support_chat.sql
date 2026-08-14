-- 0057_support_chat.sql — autonomous support chat: RAG knowledge base + inquiry recording.
--
-- Powers a free, self-hosted support assistant: the site embeds a chat widget, questions are
-- answered from a grounded knowledge base (docs) via pgvector similarity, and EVERY inquiry is
-- recorded per brand so operators (admin / superadmin / platform_superadmin) can analyse them.
--
-- Design:
--  * kb_chunks holds embedded doc chunks. site_id NULL = SHARED knowledge (all brands); a non-null
--    site_id is a per-brand override. Retrieval returns shared + the caller brand's own chunks.
--  * support_conversations / support_messages record the full transcript per brand (site_id), with
--    the assistant's retrieved citations + a confidence score, and an escalation flag + captured
--    contact when the bot hands off to a human.
--  * All writes + retrieval go through SECURITY DEFINER RPCs the API calls as service_role (the
--    visitor never touches the DB directly). Operators READ via RLS: sel_admin reuses 0056's
--    is_site_admin(site_id) so a site operator sees only its brand and platform_superadmin sees all.
-- Additive + idempotent.

create extension if not exists vector;

-- ── Knowledge base ────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid references public.sites(id) on delete cascade,   -- NULL = shared across brands
  source      text not null,                 -- e.g. 'docs/07-wallet-transactions.md'
  heading     text,                           -- nearest heading, for citation
  chunk_index int  not null default 0,
  content     text not null,
  embedding   vector(384) not null,           -- bge-small-en-v1.5 (normalised)
  token_count int,
  created_at  timestamptz not null default now()
);
create index if not exists kb_chunks_site_idx on public.kb_chunks(site_id);
do $idx$
begin
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='kb_chunks_embedding_idx') then
    execute 'create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops)';
  end if;
exception when others then
  null;   -- hnsw unavailable on older pgvector -> sequential scan (KB is small)
end
$idx$;

-- Top-k retrieval for a brand: shared KB (site_id null) plus that brand's own overrides.
create or replace function public.fn_kb_search(p_site_id uuid, p_embedding vector(384), p_k int default 5)
returns table(id uuid, source text, heading text, content text, distance real)
language sql stable security definer set search_path = public
as $$
  select k.id, k.source, k.heading, k.content, (k.embedding <=> p_embedding)::real as distance
    from public.kb_chunks k
   where k.site_id is null or k.site_id = p_site_id
   order by k.embedding <=> p_embedding
   limit greatest(p_k, 1)
$$;

-- ── Inquiry recording ───────────────────────────────────────────────────────────────────────────
create table if not exists public.support_conversations (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  user_id       uuid references public.profiles(id),   -- null for anonymous visitors
  visitor_id    text,                                   -- anonymous browser id
  status        text not null default 'open' check (status in ('open','resolved','escalated')),
  contact_email text,
  contact_phone text,
  escalated     boolean not null default false,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_at       timestamptz not null default now()
);
create index if not exists support_conv_site_idx on public.support_conversations(site_id, last_at desc);

create table if not exists public.support_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  site_id         uuid not null references public.sites(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  sources         jsonb not null default '[]'::jsonb,   -- retrieved citations for assistant turns
  confidence      real,                                  -- 0..1 for assistant turns
  created_at      timestamptz not null default now()
);
create index if not exists support_msg_conv_idx on public.support_messages(conversation_id, created_at);
create index if not exists support_msg_site_idx on public.support_messages(site_id, created_at desc);

-- ── RPCs (service_role; the API holds the DB connection, visitors never do) ──────────────────────
create or replace function public.fn_support_start(p_site_id uuid, p_visitor text default null, p_user uuid default null)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid;
begin
  if not exists (select 1 from public.sites where id = p_site_id) then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.support_conversations(site_id, visitor_id, user_id)
    values (p_site_id, nullif(btrim(coalesce(p_visitor,'')),''), p_user)
    returning id into v_id;
  return v_id;
end $fn$;

create or replace function public.fn_support_log(
  p_conversation uuid, p_role text, p_content text, p_sources jsonb default '[]'::jsonb, p_confidence real default null
) returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; v_id uuid;
begin
  if p_role not in ('user','assistant','system') then raise exception 'INVALID_ROLE'; end if;
  if coalesce(btrim(p_content),'') = '' then raise exception 'EMPTY_CONTENT'; end if;
  select site_id into v_site from public.support_conversations where id = p_conversation;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  insert into public.support_messages(conversation_id, site_id, role, content, sources, confidence)
    values (p_conversation, v_site, p_role, p_content, coalesce(p_sources,'[]'::jsonb), p_confidence)
    returning id into v_id;
  update public.support_conversations set last_at = now() where id = p_conversation;
  return v_id;
end $fn$;

create or replace function public.fn_support_escalate(p_conversation uuid, p_email text default null, p_phone text default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  update public.support_conversations
     set escalated = true, status = 'escalated',
         contact_email = coalesce(nullif(btrim(coalesce(p_email,'')),''), contact_email),
         contact_phone = coalesce(nullif(btrim(coalesce(p_phone,'')),''), contact_phone),
         last_at = now()
   where id = p_conversation;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
end $fn$;

-- ── RLS: operators READ their brand; everything else is service_role-only ────────────────────────
alter table public.kb_chunks             enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages      enable row level security;
do $mig$
begin
  drop policy if exists sel_admin on public.support_conversations;
  create policy sel_admin on public.support_conversations for select to authenticated
    using (public.is_site_admin(site_id));
  drop policy if exists sel_admin on public.support_messages;
  create policy sel_admin on public.support_messages for select to authenticated
    using (public.is_site_admin(site_id));
end
$mig$;

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────
do $g$
begin
  revoke all on function public.fn_kb_search(uuid,vector,int)                    from public, anon, authenticated;
  revoke all on function public.fn_support_start(uuid,text,uuid)                 from public, anon, authenticated;
  revoke all on function public.fn_support_log(uuid,text,text,jsonb,real)        from public, anon, authenticated;
  revoke all on function public.fn_support_escalate(uuid,text,text)              from public, anon, authenticated;
  grant execute on function public.fn_kb_search(uuid,vector,int)                 to service_role;
  grant execute on function public.fn_support_start(uuid,text,uuid)              to service_role;
  grant execute on function public.fn_support_log(uuid,text,text,jsonb,real)     to service_role;
  grant execute on function public.fn_support_escalate(uuid,text,text)           to service_role;
end
$g$;
