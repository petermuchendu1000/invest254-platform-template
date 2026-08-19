-- 0068_marketer_expenses.sql — transparent, admin-logged expenses attributed to a marketer.
--
-- Purpose: total transparency for marketers. An admin logs costs tied to a marketer (e.g. TikTok
-- account promotion, data bundles, advance payments), and the marketer sees every entry in their
-- hidden dashboard. This is an INFORMATIONAL ledger for trust — it does NOT alter commission or
-- payout money math (the affiliate payout RPCs are untouched). Additive + idempotent.
create table if not exists public.marketer_expenses (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id),
  marketer_user_id uuid not null,           -- the affiliate marketer's user id (profiles.id)
  category      text not null,              -- e.g. 'tiktok_promo' | 'data_bundles' | 'advance' | 'other'
  amount_cents  bigint not null check (amount_cents > 0),
  note          text,
  created_by    uuid,                       -- admin who logged it
  created_at    timestamptz not null default now()
);
create index if not exists idx_marketer_expenses_user on public.marketer_expenses(marketer_user_id, created_at desc);
create index if not exists idx_marketer_expenses_site on public.marketer_expenses(site_id, created_at desc);

-- Admin logs an expense (audited). SECURITY DEFINER so it works regardless of the API's DB role/RLS.
create or replace function public.fn_admin_add_marketer_expense(
  p_actor uuid, p_actor_role text, p_site uuid, p_marketer uuid,
  p_category text, p_amount bigint, p_note text)
returns public.marketer_expenses
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.marketer_expenses;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_category is null or length(trim(p_category)) = 0 then raise exception 'CATEGORY_REQUIRED'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  insert into public.marketer_expenses(site_id, marketer_user_id, category, amount_cents, note, created_by)
    values (p_site, p_marketer, trim(p_category), p_amount, nullif(trim(coalesce(p_note,'')), ''), p_actor)
    returning * into v_row;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'marketer.expense.add', 'profiles', p_marketer::text,
            jsonb_build_object('category', v_row.category, 'amount_cents', v_row.amount_cents, 'note', v_row.note), p_site);
  return v_row;
end;
$fn$;

-- Read a marketer's expenses (newest first). SECURITY DEFINER so both the admin view and the
-- marketer's own dashboard resolve regardless of RLS. Callers scope authorization in the API layer.
create or replace function public.fn_marketer_expenses(p_marketer uuid, p_limit int)
returns setof public.marketer_expenses
language sql security definer set search_path = public
as $fn$
  select * from public.marketer_expenses
   where marketer_user_id = p_marketer
   order by created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;
