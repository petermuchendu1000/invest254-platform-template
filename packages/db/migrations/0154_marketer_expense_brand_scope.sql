-- 0154_marketer_expense_brand_scope.sql — Issue 1 / F-44 (BUGLOG #44): an admin-logged marketer
-- expense must live on the MARKETER's brand.
--
-- BUG: fn_admin_add_marketer_expense (0068) inserted the expense with the caller-supplied p_site and
-- never checked that the marketer belongs to it. The API passed the ADMIN's brand, so:
--   * a site admin of brand A could log an "expense" against brand B's marketer — and because
--     fn_marketer_expenses_total() sums a marketer's expenses across all brands, that directly cut
--     brand B's marketer's WITHDRAWABLE (cross-tenant financial sabotage);
--   * the system owner's expenses for other brands' marketers were recorded on its home brand
--     (production forensics 2026-09-23: 4 rows — madolar x3, safitraders x1 — stamped 'invest254').
-- The API now scope-checks the marketer and passes the marketer's own brand; this migration is the
-- DB half (defense-in-depth) plus the data correction.
--
-- CHANGE (same signature, CREATE OR REPLACE):
--   * refuse when the marketer does not exist (MARKETER_NOT_FOUND);
--   * the SYSTEM owner (platform_superadmin, global scope) -> the expense is NORMALISED onto the
--     marketer's brand (p_site ignored). A brand-bounded actor -> p_site must be the marketer's brand,
--     else MARKETER_SITE_MISMATCH (the cross-tenant sabotage path).
--   DEPLOY-ORDER SAFE: the migrate step runs before the new API ships. The OLD API passes the admin's
--   brand as p_site; for the owner that is normalised (not refused), and for a site admin acting on its
--   own brand's marketer it already matches — so no legitimate call breaks under old OR new code.
--   Everything else is byte-for-byte the 0068 body.
--   * data fix: re-stamp existing expense rows whose site_id differs from the marketer's brand
--     (amounts untouched; the marketer's withdrawable is unchanged — the total is per marketer).
-- Idempotent.

create or replace function public.fn_admin_add_marketer_expense(
  p_actor uuid, p_actor_role text, p_site uuid, p_marketer uuid, p_category text, p_amount bigint, p_note text
) returns public.marketer_expenses
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.marketer_expenses; v_marketer_site uuid;
begin
  if p_actor_role not in ('admin','superadmin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  -- Issue 1 / F-44: the expense belongs to the marketer's brand, never another one.
  select site_id into v_marketer_site from public.profiles where id = p_marketer;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  if p_actor_role = 'platform_superadmin' then
    p_site := v_marketer_site;                       -- global owner: normalise onto the marketer's brand
  elsif p_site is distinct from v_marketer_site then
    raise exception 'MARKETER_SITE_MISMATCH';        -- a bounded actor may not cross brands
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

-- Keep the 0151 posture explicit for this SECURITY DEFINER function.
revoke execute on function public.fn_admin_add_marketer_expense(uuid, text, uuid, uuid, text, bigint, text) from anon, authenticated, public;
grant  execute on function public.fn_admin_add_marketer_expense(uuid, text, uuid, uuid, text, bigint, text) to service_role;

-- Data correction: every expense lives on its marketer's brand.
update public.marketer_expenses e
   set site_id = p.site_id
  from public.profiles p
 where p.id = e.marketer_user_id
   and e.site_id is distinct from p.site_id;
