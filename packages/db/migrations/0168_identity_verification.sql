-- 0168_identity_verification.sql — ACCT-1: player identity verification ("Verify Identity").
--
-- A player uploads an ID document (front, optional back) and a selfie, with the name, ID number and date
-- of birth on the document. The brand's back office reviews it and approves or rejects it with a note the
-- player sees. Nothing here gates money: the status is shown to the player and to staff only.
--
-- INVARIANTS (packages/db/_testkit/e2e_identity_verification.py):
--   1. At most one PENDING submission per player; an APPROVED player cannot submit again.
--   2. Files: JPEG / PNG / WebP / PDF (document sides), JPEG / PNG / WebP (selfie); each <= 6 MB; a file
--      belongs to its uploader and can be used in one submission only.
--   3. Review is scoped: a brand admin only for its brand, a platform admin only for its platform, the
--      System owner for all; a rejection needs a note; every decision is audited.
--   4. profiles.kyc_status mirrors the latest decision (none | pending | approved | rejected).
--   5. Only the service_role (the API) may call the functions; RLS keeps everything else out.
-- Additive + idempotent.

begin;

alter table public.profiles add column if not exists kyc_status text not null default 'none'
  check (kyc_status in ('none','pending','approved','rejected'));

create table if not exists public.kyc_files (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  mime       text not null,
  size_bytes int  not null,
  data       bytea not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_kyc_files_user on public.kyc_files(user_id, created_at desc);

create table if not exists public.kyc_submissions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  site_id      uuid not null references public.sites(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  doc_type     text not null check (doc_type in ('national_id','passport','driving_licence')),
  full_name    text not null check (length(btrim(full_name)) between 3 and 120),
  id_number    text not null check (length(btrim(id_number)) between 4 and 40),
  date_of_birth date not null,
  front_file   uuid not null references public.kyc_files(id),
  back_file    uuid references public.kyc_files(id),
  selfie_file  uuid not null references public.kyc_files(id),
  submitted_at timestamptz not null default now(),
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text
);
create unique index if not exists uq_kyc_pending on public.kyc_submissions(user_id) where status = 'pending';
create index if not exists idx_kyc_site on public.kyc_submissions(site_id, status, submitted_at desc);

alter table public.kyc_files       enable row level security;
alter table public.kyc_submissions enable row level security;

create or replace function public.fn_kyc_upload(p_user uuid, p_mime text, p_data bytea)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_size int := octet_length(p_data);
begin
  if p_mime not in ('image/jpeg','image/png','image/webp','application/pdf') then raise exception 'UNSUPPORTED_FILE'; end if;
  if v_size = 0 then raise exception 'EMPTY_FILE'; end if;
  if v_size > 6291456 then raise exception 'FILE_TOO_LARGE'; end if;
  -- no more than 12 unused uploads per player per day (stops storage abuse)
  if (select count(*) from kyc_files where user_id = p_user and not used and created_at > now() - interval '1 day') >= 12 then
    raise exception 'TOO_MANY_UPLOADS';
  end if;
  insert into kyc_files(user_id, mime, size_bytes, data) values (p_user, p_mime, v_size, p_data) returning id into v_id;
  return v_id;
end $fn$;

create or replace function public.fn_kyc_submit(p_user uuid, p_site uuid, p_doc_type text, p_full_name text, p_id_number text,
                                                p_dob date, p_front uuid, p_back uuid, p_selfie uuid)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_status text; f uuid;
begin
  if not exists (select 1 from profiles where id = p_user and site_id = p_site) then raise exception 'NOT_YOUR_BRAND'; end if;
  select kyc_status into v_status from profiles where id = p_user;
  if v_status = 'approved' then raise exception 'ALREADY_VERIFIED'; end if;
  if exists (select 1 from kyc_submissions where user_id = p_user and status = 'pending') then raise exception 'ALREADY_PENDING'; end if;
  if p_dob is null or p_dob > (current_date - interval '18 years') or p_dob < date '1900-01-01' then raise exception 'INVALID_DOB'; end if;
  foreach f in array array[p_front, p_selfie, p_back] loop
    if f is null then continue; end if;
    if not exists (select 1 from kyc_files where id = f and user_id = p_user and not used) then raise exception 'FILE_NOT_FOUND'; end if;
  end loop;
  if (select mime from kyc_files where id = p_selfie) = 'application/pdf' then raise exception 'SELFIE_MUST_BE_PHOTO'; end if;
  if p_front = p_selfie or p_front = p_back or p_back = p_selfie then raise exception 'FILE_REUSED'; end if;
  insert into kyc_submissions(user_id, site_id, doc_type, full_name, id_number, date_of_birth, front_file, back_file, selfie_file)
    values (p_user, p_site, p_doc_type, btrim(p_full_name), upper(btrim(p_id_number)), p_dob, p_front, p_back, p_selfie)
    returning id into v_id;
  update kyc_files set used = true where id in (p_front, p_selfie) or id = p_back;
  update profiles set kyc_status = 'pending' where id = p_user;
  return v_id;
end $fn$;

-- Review: approve / reject (rejection needs a note). Scoped like every other brand action.
create or replace function public.fn_kyc_review(p_actor uuid, p_actor_role text, p_submission uuid, p_decision text, p_note text)
returns text language plpgsql security definer set search_path = public as $fn$
declare v_site uuid; v_user uuid; v_status text; v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if p_decision not in ('approved','rejected') then raise exception 'INVALID_DECISION'; end if;
  if p_decision = 'rejected' and v_note is null then raise exception 'NOTE_REQUIRED'; end if;
  select site_id, user_id, status into v_site, v_user, v_status from kyc_submissions where id = p_submission for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  if v_status <> 'pending' then raise exception 'ALREADY_REVIEWED'; end if;
  if p_actor_role not in ('admin','platform_admin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  -- PERMISSION verified against the actor's REAL profile (0158): genuine brand admin -> its brand,
  -- platform admin (also when opening a brand) -> its platform, System owner -> all.
  if not exists (select 1 from fn_actor_scope_sites(p_actor, p_actor_role) x where x.site_id = v_site) then
    raise exception 'SITE_SCOPE_FORBIDDEN';
  end if;
  update kyc_submissions set status = p_decision, reviewed_by = p_actor, reviewed_at = now(), review_note = v_note where id = p_submission;
  update profiles set kyc_status = p_decision where id = v_user;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'kyc.review', 'user', v_user::text,
            jsonb_build_object('submission', p_submission, 'decision', p_decision, 'note', v_note), v_site);
  return p_decision;
end $fn$;

-- Unused uploads older than two days are removed (a player who never submits leaves nothing behind).
create or replace function public.fn_kyc_prune_uploads()
returns int language sql security definer set search_path = public as $fn$
  with d as (delete from kyc_files where not used and created_at < now() - interval '2 days' returning 1)
  select count(*)::int from d;
$fn$;

do $g$
declare f text;
begin
  foreach f in array array[
    'fn_kyc_upload(uuid,text,bytea)', 'fn_kyc_submit(uuid,uuid,text,text,text,date,uuid,uuid,uuid)',
    'fn_kyc_review(uuid,text,uuid,text,text)', 'fn_kyc_prune_uploads()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$g$;

commit;
