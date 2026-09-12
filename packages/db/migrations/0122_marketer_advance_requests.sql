-- 0122_marketer_advance_requests.sql — marketer-initiated advance requests with an admin approve/reject
-- lifecycle (Issue: "marketers can request an advance; sent to admin who accepts/rejects; the system
-- communicates; if rejected show, if approved show AND log").
--
-- MODEL:
--   A marketer requests a cash advance against future commission. An admin approves or rejects.
--     - APPROVE  -> the advance is LOGGED as a marketer_expenses row (category 'advance') keyed to the
--                   marketer's affiliate profiles.id (the SAME key fn_commission_balance and the
--                   dashboard read — migrations 0068/0105/0121), so it immediately reduces the
--                   marketer's withdrawable and shows in their Expenses & advances statement.
--     - REJECT   -> recorded with the admin's reason; nothing is logged against the marketer's money.
--   Cash disbursement is handled by the existing (manual) payout flow — this migration does NOT move
--   money; it only records the request, the decision, and (on approval) the expense/advance ledger row.
--
-- COMMUNICATION: the API layer notifies the marketer (in-app notification) on every decision and the
--   admin queue surfaces new requests; this migration is money-neutral except for the approved expense.
-- Additive, idempotent, SECURITY DEFINER (parity with the other marketer RPCs so it resolves under RLS).

create table if not exists public.marketer_advance_requests (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references public.sites(id),
  marketer_user_id uuid not null,                       -- affiliate profiles.id (same key as marketer_expenses)
  amount_cents     bigint not null check (amount_cents > 0),
  reason           text,                                -- the marketer's stated reason
  status           text not null default 'requested'
                     check (status in ('requested','approved','rejected','cancelled')),
  decided_by       uuid,                                -- admin who approved/rejected
  decided_at       timestamptz,
  decision_note    text,                                -- admin note / rejection reason
  expense_id       uuid references public.marketer_expenses(id),  -- the logged advance (on approval)
  created_at       timestamptz not null default now()
);
create index if not exists idx_marketer_adv_user   on public.marketer_advance_requests(marketer_user_id, created_at desc);
create index if not exists idx_marketer_adv_site    on public.marketer_advance_requests(site_id, status, created_at desc);
-- At most ONE open (requested) advance per marketer at a time — a partial unique index (guards double-submit).
create unique index if not exists uq_marketer_adv_one_open
  on public.marketer_advance_requests(marketer_user_id) where status = 'requested';

-- Marketer requests an advance. Guards: positive amount, one open request at a time. Returns the row.
create or replace function public.fn_marketer_request_advance(p_user uuid, p_amount bigint, p_reason text)
returns public.marketer_advance_requests
language plpgsql security definer set search_path = public
as $fn$
declare v_site uuid; v_row public.marketer_advance_requests;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if exists (select 1 from public.marketer_advance_requests
              where marketer_user_id = p_user and status = 'requested') then
    raise exception 'ADVANCE_PENDING';
  end if;
  select site_id into v_site from public.profiles where id = p_user;
  if v_site is null then raise exception 'NOT_FOUND'; end if;
  insert into public.marketer_advance_requests(site_id, marketer_user_id, amount_cents, reason)
    values (v_site, p_user, p_amount, nullif(btrim(coalesce(p_reason,'')), ''))
    returning * into v_row;
  return v_row;
end;
$fn$;

-- Marketer cancels their OWN still-pending request (safety valve; idempotent-guarded).
create or replace function public.fn_marketer_cancel_advance(p_user uuid, p_id uuid)
returns public.marketer_advance_requests
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.marketer_advance_requests;
begin
  update public.marketer_advance_requests
     set status = 'cancelled', decided_at = now()
   where id = p_id and marketer_user_id = p_user and status = 'requested'
   returning * into v_row;
  if not found then raise exception 'INVALID_STATE'; end if;
  return v_row;
end;
$fn$;

-- Admin approves or rejects. APPROVE logs a marketer_expenses 'advance' row (reduces withdrawable) and
-- links it; REJECT records the reason. Both are audited. Only a 'requested' row can be decided.
create or replace function public.fn_admin_decide_advance(
  p_actor uuid, p_actor_role text, p_id uuid, p_approve boolean, p_note text)
returns public.marketer_advance_requests
language plpgsql security definer set search_path = public
as $fn$
declare v_req public.marketer_advance_requests; v_exp public.marketer_expenses; v_note text;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  v_note := nullif(btrim(coalesce(p_note,'')), '');

  select * into v_req from public.marketer_advance_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_req.status <> 'requested' then raise exception 'INVALID_STATE'; end if;

  if p_approve then
    -- Log the advance as a marketer_expense (category 'advance') — nets the marketer's withdrawable.
    insert into public.marketer_expenses(site_id, marketer_user_id, category, amount_cents, note, created_by)
      values (v_req.site_id, v_req.marketer_user_id, 'advance', v_req.amount_cents,
              coalesce(v_note, v_req.reason, 'Advance request approved'), p_actor)
      returning * into v_exp;
    update public.marketer_advance_requests
       set status = 'approved', decided_by = p_actor, decided_at = now(),
           decision_note = v_note, expense_id = v_exp.id
     where id = p_id returning * into v_req;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'marketer.advance.approve', 'marketer_advance_requests', p_id::text,
              jsonb_build_object('amount_cents', v_req.amount_cents, 'expense_id', v_exp.id, 'note', v_note), v_req.site_id);
  else
    update public.marketer_advance_requests
       set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_id returning * into v_req;
    insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
      values (p_actor, p_actor_role, 'marketer.advance.reject', 'marketer_advance_requests', p_id::text,
              jsonb_build_object('amount_cents', v_req.amount_cents, 'reason', v_note), v_req.site_id);
  end if;
  return v_req;
end;
$fn$;

-- A marketer's own advance requests (newest first).
create or replace function public.fn_marketer_advances(p_user uuid, p_limit int)
returns setof public.marketer_advance_requests
language sql security definer set search_path = public
as $fn$
  select * from public.marketer_advance_requests
   where marketer_user_id = p_user
   order by created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

-- Admin queue: advance requests for a site (or all when p_site is null), optionally filtered by status.
create or replace function public.fn_admin_advance_requests(p_site uuid, p_status text, p_limit int)
returns table(
  id uuid, site_id uuid, marketer_user_id uuid, username text, phone text,
  amount_cents bigint, reason text, status text, decided_by uuid, decided_at timestamptz,
  decision_note text, expense_id uuid, created_at timestamptz)
language sql security definer set search_path = public
as $fn$
  select r.id, r.site_id, r.marketer_user_id, pr.username, pr.phone,
         r.amount_cents, r.reason, r.status, r.decided_by, r.decided_at,
         r.decision_note, r.expense_id, r.created_at
    from public.marketer_advance_requests r
    left join public.profiles pr on pr.id = r.marketer_user_id
   where (p_site is null or r.site_id = p_site)
     and (p_status is null or r.status = p_status)
   order by (r.status = 'requested') desc, r.created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

revoke all on function public.fn_marketer_request_advance(uuid, bigint, text),
  public.fn_marketer_cancel_advance(uuid, uuid),
  public.fn_admin_decide_advance(uuid, text, uuid, boolean, text),
  public.fn_marketer_advances(uuid, int),
  public.fn_admin_advance_requests(uuid, text, int) from public, anon, authenticated;
grant execute on function public.fn_marketer_request_advance(uuid, bigint, text),
  public.fn_marketer_cancel_advance(uuid, uuid),
  public.fn_admin_decide_advance(uuid, text, uuid, boolean, text),
  public.fn_marketer_advances(uuid, int),
  public.fn_admin_advance_requests(uuid, text, int) to service_role;
