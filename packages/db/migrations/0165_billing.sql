-- 0165_billing.sql — BILL-1 (docs/47): invoices, invoice lines, payments (M-Pesa STK + manual), pending charges,
-- add-on pricing models, invoice-driven dunning, billing settings and revenue reads.
--
-- Bill-to is the PLATFORM (one consolidated invoice: plan + every brand's add-ons, each line naming the brand).
-- Invoices are billed in ADVANCE at each renewal and fall due after the payment terms. Dunning is driven by the
-- OLDEST UNPAID invoice (past_due -> grace_period -> suspended, ops_config durations). A paid-up platform returns to
-- active. The System's own default platform is billing-exempt. Money records are System-owner only; a platform
-- admin reads its own invoices and can start an M-Pesa payment for them. SECURITY DEFINER, service_role only,
-- audited. Additive; fn_subscription_auto_advance() now delegates to fn_billing_run(). Idempotent.

-- ── 1. Settings (singleton) ─────────────────────────────────────────────────────────────────────
create table if not exists public.billing_settings (
  id                   boolean primary key default true check (id),
  business_name        text not null default 'TrioCodes',
  business_address     text not null default '',
  tax_pin              text not null default '',
  billing_email        text not null default '',
  billing_phone        text not null default '',
  invoice_prefix       text not null default 'TRIO' check (invoice_prefix ~ '^[A-Z0-9]{2,8}$'),
  next_number          int  not null default 1 check (next_number > 0),
  days_until_due       int  not null default 7 check (days_until_due between 0 and 90),
  tax_rate_bp          int  not null default 0 check (tax_rate_bp between 0 and 5000),
  tax_label            text not null default 'VAT',
  payment_instructions text not null default '',
  mpesa_pay_enabled    boolean not null default true,
  footer_note          text not null default '',
  updated_by           uuid references public.profiles(id),
  updated_at           timestamptz not null default now()
);
insert into public.billing_settings (id) values (true) on conflict (id) do nothing;
alter table public.billing_settings enable row level security;

-- ── 2. Subscriptions: exemption (the System's own platform is never invoiced) ──────────────────
alter table public.platform_subscriptions add column if not exists billing_exempt boolean not null default false;
update public.platform_subscriptions set billing_exempt = true where platform_id = '10000000-0000-0000-0000-000000000001';

-- ── 3. Add-on pricing models ────────────────────────────────────────────────────────────────────
alter table public.addon_catalog add column if not exists billing_type    text   not null default 'one_off';
alter table public.addon_catalog add column if not exists setup_fee_cents bigint not null default 0 check (setup_fee_cents >= 0);
update public.addon_catalog set billing_type = 'free' where price_cents = 0 and billing_type = 'one_off';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'addon_catalog_billing_type_chk') then
    alter table public.addon_catalog add constraint addon_catalog_billing_type_chk check (billing_type in ('free','one_off','monthly'));
  end if;
end $$;

-- ── 4. Charges waiting for the next invoice ───────────────────────────────────────────────────────
create table if not exists public.billing_charges (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references public.platforms(id) on delete cascade,
  site_id      uuid references public.sites(id) on delete set null,
  kind         text not null check (kind in ('addon_one_off','addon_setup','adjustment','credit')),
  description  text not null check (length(description) between 1 and 200),
  amount_cents bigint not null check (amount_cents <> 0),
  source_ref   text,
  invoice_id   uuid,
  voided_at    timestamptz,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_billing_charges_pending on public.billing_charges(platform_id) where invoice_id is null and voided_at is null;
alter table public.billing_charges enable row level security;

-- ── 5. Invoices, lines, payments ────────────────────────────────────────────────────────────────
create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  number            text unique,
  platform_id       uuid not null references public.platforms(id) on delete restrict,
  kind              text not null default 'renewal' check (kind in ('renewal','manual')),
  status            text not null default 'open' check (status in ('draft','open','paid','void','uncollectible')),
  currency          text not null default 'KES',
  period_start      timestamptz,
  period_end        timestamptz,
  plan_key          text,
  issued_at         timestamptz not null default now(),
  due_at            timestamptz not null,
  subtotal_cents    bigint not null default 0,
  tax_rate_bp       int not null default 0,
  tax_cents         bigint not null default 0,
  total_cents       bigint not null default 0,
  amount_paid_cents bigint not null default 0,
  paid_at           timestamptz,
  voided_at         timestamptz,
  status_reason     text,
  notes             text,
  reminder_stage    int not null default 0,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_invoices_renewal_period on public.invoices(platform_id, period_start) where kind = 'renewal';
create index if not exists idx_invoices_platform on public.invoices(platform_id, issued_at desc);
create index if not exists idx_invoices_unpaid on public.invoices(due_at) where status = 'open';
alter table public.invoices enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_charges_invoice_fk') then
    alter table public.billing_charges add constraint billing_charges_invoice_fk foreign key (invoice_id) references public.invoices(id) on delete set null;
  end if;
end $$;

create table if not exists public.invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  kind         text not null check (kind in ('plan','addon_monthly','addon_one_off','addon_setup','adjustment','credit')),
  description  text not null,
  site_id      uuid references public.sites(id) on delete set null,
  quantity     int not null default 1 check (quantity > 0),
  unit_cents   bigint not null,
  amount_cents bigint not null,
  period_start timestamptz,
  period_end   timestamptz,
  sort         int not null default 0
);
create index if not exists idx_invoice_lines_invoice on public.invoice_lines(invoice_id, sort);
alter table public.invoice_lines enable row level security;

create table if not exists public.invoice_payments (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references public.invoices(id) on delete restrict,
  platform_id         uuid not null references public.platforms(id) on delete restrict,
  method              text not null check (method in ('mpesa','bank','cash','other')),
  status              text not null check (status in ('pending','succeeded','failed')),
  amount_cents        bigint not null check (amount_cents > 0),
  reference           text,
  phone               text,
  checkout_request_id text unique,
  note                text,
  failure_reason      text,
  recorded_by         uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  settled_at          timestamptz,
  raw                 jsonb
);
create index if not exists idx_invoice_payments_invoice on public.invoice_payments(invoice_id, created_at desc);
create index if not exists idx_invoice_payments_pending on public.invoice_payments(created_at) where status = 'pending';
alter table public.invoice_payments enable row level security;

-- ── 6. Helpers ──────────────────────────────────────────────────────────────────────────────────
-- Who may read/pay a platform's billing: the System owner (any), a platform admin (its own).
create or replace function public.fn_billing_assert(p_actor uuid, p_actor_role text, p_platform uuid)
returns void language plpgsql stable security definer set search_path = public
as $fn$
begin
  if p_actor_role = 'platform_superadmin' then return; end if;
  if p_actor_role = 'platform_admin' and p_platform is not null
     and p_platform = (select pr.platform_id from public.profiles pr where pr.id = p_actor) then return; end if;
  if p_actor_role = 'platform_admin' then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  raise exception 'NOT_AUTHORIZED';
end;
$fn$;

create or replace function public.fn_billing_owner(p_actor_role text)
returns void language plpgsql stable
as $fn$
begin
  if p_actor_role is distinct from 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
end;
$fn$;

-- In-app notice to a platform's admins (and optionally every System owner).
create or replace function public.fn_billing_notify(p_platform uuid, p_level text, p_title text, p_body text, p_owners boolean default false)
returns void language sql security definer set search_path = public
as $fn$
  insert into public.user_notifications(user_id, level, title, body, category)
    select pr.id, p_level, left(p_title, 120), left(p_body, 1000), 'billing'
      from public.profiles pr
     where (pr.role = 'platform_admin' and pr.platform_id = p_platform and pr.status = 'active')
        or (p_owners and pr.role = 'platform_superadmin');
$fn$;

create or replace function public.fn_billing_kes(p_cents bigint)
returns text language sql immutable
as $$ select 'KES ' || to_char(round(p_cents / 100.0), 'FM999,999,999,990') $$;

create or replace function public.fn_billing_next_number()
returns text language plpgsql security definer set search_path = public
as $fn$
declare v_prefix text; v_n int;
begin
  update public.billing_settings set next_number = next_number + 1 where id returning invoice_prefix, next_number - 1 into v_prefix, v_n;
  return v_prefix || '-' || to_char(now() at time zone 'Africa/Nairobi', 'YYYY') || '-' || lpad(v_n::text, 5, '0');
end;
$fn$;

-- Recompute an invoice's totals from its lines + succeeded payments, and settle its status.
create or replace function public.fn_billing_recalc(p_invoice uuid)
returns public.invoices language plpgsql security definer set search_path = public
as $fn$
declare v public.invoices; v_sub bigint; v_tax bigint; v_paid bigint;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  select coalesce(sum(amount_cents), 0) into v_sub from public.invoice_lines where invoice_id = p_invoice;
  -- Tax on the positive subtotal, rounded to whole shillings (M-Pesa moves whole KES).
  v_tax := case when v_sub > 0 then round(v_sub * v.tax_rate_bp / 10000.0 / 100.0)::bigint * 100 else 0 end;
  select coalesce(sum(amount_cents), 0) into v_paid from public.invoice_payments where invoice_id = p_invoice and status = 'succeeded';
  update public.invoices set subtotal_cents = v_sub, tax_cents = v_tax, total_cents = greatest(0, v_sub + v_tax),
         amount_paid_cents = v_paid,
         status = case when status in ('open','draft') and v_paid >= greatest(0, v_sub + v_tax) then 'paid' else status end,
         paid_at = case when status in ('open','draft') and v_paid >= greatest(0, v_sub + v_tax) then now() else paid_at end,
         updated_at = now()
   where id = p_invoice returning * into v;
  return v;
end;
$fn$;

-- After money arrives: a platform with no remaining OVERDUE invoice returns to active.
create or replace function public.fn_billing_reactivate_if_clear(p_platform uuid)
returns void language plpgsql security definer set search_path = public
as $fn$
declare v_status text; v_plan text;
begin
  select status, plan_key into v_status, v_plan from public.platform_subscriptions where platform_id = p_platform for update;
  if v_status in ('past_due','grace_period','suspended')
     and not exists (select 1 from public.invoices where platform_id = p_platform and status = 'open' and due_at < now()) then
    update public.platform_subscriptions set status = 'active', grace_ends_at = null, last_payment_at = now(), updated_at = now()
     where platform_id = p_platform;
    insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason)
      values (p_platform, v_status, 'active', v_plan, 'payment');
    perform public.fn_billing_notify(p_platform, 'success', 'Your account is back in good standing',
      'Thank you — your payment cleared every overdue invoice.' || case when v_status = 'suspended' then ' Your brands are back online.' else '' end, true);
  elsif v_status in ('active','trial') then
    update public.platform_subscriptions set last_payment_at = now(), updated_at = now() where platform_id = p_platform;
  end if;
end;
$fn$;

-- ── 7. Issue an invoice (internal) ──────────────────────────────────────────────────────────────
-- Renewal: the plan for [p_start, p_end) + every monthly add-on of the platform's ACTIVE brands + pending charges.
-- Manual: only the given lines (+ pending charges when p_include_pending). Returns the invoice id.
create or replace function public.fn_billing_issue(
  p_platform uuid, p_kind text, p_start timestamptz, p_end timestamptz, p_lines jsonb, p_include_pending boolean,
  p_actor uuid, p_due_days int default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid; v_set public.billing_settings; v_sub public.platform_subscriptions; v_price bigint; v_plan_name text;
        v_sort int := 0; l jsonb; c record; a record; v_inv public.invoices;
begin
  select * into v_set from public.billing_settings where id;
  select * into v_sub from public.platform_subscriptions where platform_id = p_platform;
  insert into public.invoices(number, platform_id, kind, status, period_start, period_end, plan_key, issued_at, due_at, tax_rate_bp, notes, created_by)
    values (public.fn_billing_next_number(), p_platform, p_kind, 'open', p_start, p_end, v_sub.plan_key, now(),
            now() + make_interval(days => coalesce(p_due_days, v_set.days_until_due)), v_set.tax_rate_bp, p_notes, p_actor)
    returning id into v_id;

  if p_kind = 'renewal' then
    select coalesce(v_sub.custom_price_cents, sp.price_cents), sp.name into v_price, v_plan_name
      from public.subscription_plans sp where sp.key = v_sub.plan_key;
    if coalesce(v_price, 0) > 0 then
      insert into public.invoice_lines(invoice_id, kind, description, unit_cents, amount_cents, period_start, period_end, sort)
        values (v_id, 'plan', coalesce(v_plan_name, v_sub.plan_key) || ' plan', v_price, v_price, p_start, p_end, v_sort);
      v_sort := v_sort + 1;
    end if;
    for a in
      select s.id as site_id, s.name as site_name, ac.display_name, ac.price_cents
        from public.brand_entitlements be
        join public.sites s on s.id = be.site_id and s.status = 'active' and s.platform_id = p_platform
        join public.addon_catalog ac on ac.category = be.category and ac.key = be.key
       where ac.billing_type = 'monthly' and ac.price_cents > 0 and not ac.is_default
       order by s.name, ac.display_name
    loop
      insert into public.invoice_lines(invoice_id, kind, description, site_id, unit_cents, amount_cents, period_start, period_end, sort)
        values (v_id, 'addon_monthly', a.display_name || ' — ' || a.site_name, a.site_id, a.price_cents, a.price_cents, p_start, p_end, v_sort);
      v_sort := v_sort + 1;
    end loop;
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.invoice_lines(invoice_id, kind, description, site_id, quantity, unit_cents, amount_cents, sort)
      values (v_id, coalesce(l->>'kind', 'adjustment'), l->>'description', nullif(l->>'siteId','')::uuid,
              coalesce((l->>'quantity')::int, 1), (l->>'unitCents')::bigint,
              (l->>'unitCents')::bigint * coalesce((l->>'quantity')::int, 1), v_sort);
    v_sort := v_sort + 1;
  end loop;

  if p_include_pending then
    for c in select * from public.billing_charges where platform_id = p_platform and invoice_id is null and voided_at is null order by created_at for update loop
      insert into public.invoice_lines(invoice_id, kind, description, site_id, unit_cents, amount_cents, sort)
        values (v_id, c.kind, c.description, c.site_id, c.amount_cents, c.amount_cents, v_sort);
      update public.billing_charges set invoice_id = v_id where id = c.id;
      v_sort := v_sort + 1;
    end loop;
  end if;

  v_inv := public.fn_billing_recalc(v_id);
  -- Credits larger than the charges are never lost: the excess is carried to the next invoice.
  if v_inv.subtotal_cents < 0 then
    insert into public.billing_charges(platform_id, kind, description, amount_cents, source_ref, created_by)
      values (p_platform, 'credit', 'Credit carried forward from ' || v_inv.number, v_inv.subtotal_cents, 'carry:' || v_id::text, p_actor);
  end if;
  if v_inv.total_cents = 0 then
    update public.invoices set status = 'paid', paid_at = now(), status_reason = 'Nothing to pay', reminder_stage = 1 where id = v_id;
  else
    update public.invoices set reminder_stage = 1 where id = v_id;
    perform public.fn_billing_notify(p_platform, 'info', 'New invoice ' || v_inv.number || ' · ' || public.fn_billing_kes(v_inv.total_cents),
      'Due ' || to_char(v_inv.due_at at time zone 'Africa/Nairobi', 'DD Mon YYYY') || '. Open Billing to view or pay it.');
  end if;
  return v_id;
end;
$fn$;

-- Is there anything to bill at a renewal? (A custom-priced plan with no price, no paid monthly add-ons and no
-- pending charges only rolls its period forward — no KES 0 invoice noise.)
create or replace function public.fn_billing_renewal_billable(p_platform uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select coalesce(ps.custom_price_cents, sp.price_cents, 0) > 0
                     from public.platform_subscriptions ps left join public.subscription_plans sp on sp.key = ps.plan_key
                    where ps.platform_id = p_platform), false)
      or exists (select 1 from public.brand_entitlements be
                   join public.sites s on s.id = be.site_id and s.status = 'active' and s.platform_id = p_platform
                   join public.addon_catalog ac on ac.category = be.category and ac.key = be.key
                  where ac.billing_type = 'monthly' and ac.price_cents > 0 and not ac.is_default)
      or exists (select 1 from public.billing_charges c where c.platform_id = p_platform and c.invoice_id is null and c.voided_at is null)
$$;

-- ── 8. The daily billing run: renewals, dunning, reminders ────────────────────────────────────────
create or replace function public.fn_billing_run(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare s record; v_anchor timestamptz; v_end timestamptz; v_i int; v_issued int := 0; v_moved int := 0; v_reminders int := 0;
        v_past int; v_grace int; v_oldest public.invoices; inv record; v_was_trial boolean;
begin
  select coalesce(sub_past_due_days, 7), coalesce(sub_grace_days, 7) into v_past, v_grace from public.ops_config where id;
  v_past := coalesce(v_past, 7); v_grace := coalesce(v_grace, 7);

  for s in select * from public.platform_subscriptions
            where not billing_exempt and status in ('trial','active','past_due','grace_period') for update
  loop
    -- a) Renewals (bill in advance; catch up to 12 missed periods).
    v_i := 0;
    loop
      v_anchor := case when s.status = 'trial' then s.trial_ends_at else s.current_period_end end;
      exit when v_anchor is null or v_anchor > p_now or v_i >= 12;
      v_end := public.fn_sub_period_end(s.plan_key, v_anchor);
      v_was_trial := s.status = 'trial';
      if not exists (select 1 from public.invoices where platform_id = s.platform_id and kind = 'renewal' and period_start = v_anchor)
         and public.fn_billing_renewal_billable(s.platform_id) then
        perform public.fn_billing_issue(s.platform_id, 'renewal', v_anchor, v_end, null, true, null);
        v_issued := v_issued + 1;
      end if;
      update public.platform_subscriptions set current_period_start = v_anchor, current_period_end = v_end,
             status = case when status = 'trial' then 'active' else status end, updated_at = now()
       where platform_id = s.platform_id returning * into s;
      if v_was_trial then
        insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason)
          values (s.platform_id, 'trial', 'active', s.plan_key, 'trial_converted');
      end if;
      v_i := v_i + 1;
    end loop;

    -- b) Dunning on the OLDEST unpaid invoice.
    select * into v_oldest from public.invoices where platform_id = s.platform_id and status = 'open' order by due_at limit 1;
    if found and v_oldest.due_at < p_now then
      if s.status = 'active' then
        update public.platform_subscriptions set status = 'past_due', updated_at = now() where platform_id = s.platform_id;
        insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason, detail)
          values (s.platform_id, 'active', 'past_due', s.plan_key, 'past_due', jsonb_build_object('invoice', v_oldest.number));
        v_moved := v_moved + 1; s.status := 'past_due';
      end if;
      if s.status = 'past_due' and p_now >= v_oldest.due_at + make_interval(days => v_past) then
        update public.platform_subscriptions set status = 'grace_period', grace_ends_at = p_now + make_interval(days => v_grace), updated_at = now()
         where platform_id = s.platform_id;
        insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason, detail)
          values (s.platform_id, 'past_due', 'grace_period', s.plan_key, 'grace', jsonb_build_object('invoice', v_oldest.number));
        perform public.fn_billing_notify(s.platform_id, 'error', 'Final notice: pay ' || v_oldest.number || ' to avoid suspension',
          'Your brands will be taken offline on ' || to_char((p_now + make_interval(days => v_grace)) at time zone 'Africa/Nairobi', 'DD Mon YYYY')
          || ' unless ' || public.fn_billing_kes(v_oldest.total_cents - v_oldest.amount_paid_cents) || ' is paid.', true);
        update public.invoices set reminder_stage = greatest(reminder_stage, 4) where id = v_oldest.id;
        v_moved := v_moved + 1;
      elsif s.status = 'grace_period' and s.grace_ends_at is not null and p_now >= s.grace_ends_at then
        update public.platform_subscriptions set status = 'suspended', updated_at = now() where platform_id = s.platform_id;
        insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason, detail)
          values (s.platform_id, 'grace_period', 'suspended', s.plan_key, 'suspended', jsonb_build_object('invoice', v_oldest.number));
        perform public.fn_billing_notify(s.platform_id, 'error', 'Your platform is suspended',
          'Your brands are offline because ' || v_oldest.number || ' is unpaid. Pay it from Billing to bring them back straight away.', true);
        update public.invoices set reminder_stage = greatest(reminder_stage, 5) where id = v_oldest.id;
        v_moved := v_moved + 1;
      end if;
    end if;
  end loop;

  -- c) Reminders (once per stage per invoice): due within 3 days (stage 2), overdue (stage 3).
  for inv in select * from public.invoices i
              where i.status = 'open' and exists (select 1 from public.platform_subscriptions ps where ps.platform_id = i.platform_id and not ps.billing_exempt)
  loop
    if inv.due_at < p_now and inv.reminder_stage < 3 then
      perform public.fn_billing_notify(inv.platform_id, 'warning', 'Invoice ' || inv.number || ' is overdue',
        public.fn_billing_kes(inv.total_cents - inv.amount_paid_cents) || ' was due on ' || to_char(inv.due_at at time zone 'Africa/Nairobi', 'DD Mon YYYY') || '. Pay it from Billing.');
      update public.invoices set reminder_stage = 3 where id = inv.id; v_reminders := v_reminders + 1;
    elsif inv.due_at >= p_now and inv.due_at <= p_now + interval '3 days' and inv.reminder_stage < 2 then
      perform public.fn_billing_notify(inv.platform_id, 'info', 'Invoice ' || inv.number || ' is due soon',
        public.fn_billing_kes(inv.total_cents - inv.amount_paid_cents) || ' is due on ' || to_char(inv.due_at at time zone 'Africa/Nairobi', 'DD Mon YYYY') || '.');
      update public.invoices set reminder_stage = 2 where id = inv.id; v_reminders := v_reminders + 1;
    end if;
  end loop;

  return jsonb_build_object('issued', v_issued, 'transitions', v_moved, 'reminders', v_reminders);
end;
$fn$;

-- The existing daily cron (0137) now runs the invoice-driven billing cycle.
create or replace function public.fn_subscription_auto_advance()
returns integer language plpgsql security definer set search_path = public as $fn$
declare r jsonb;
begin
  r := public.fn_billing_run(now());
  return coalesce((r->>'transitions')::int, 0) + coalesce((r->>'issued')::int, 0);
end;
$fn$;

-- ── 9. Owner actions ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_billing_run_now(p_actor uuid, p_actor_role text)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare r jsonb;
begin
  perform public.fn_billing_owner(p_actor_role);
  r := public.fn_billing_run(now());
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.run', 'billing', 'run', r);
  return r;
end;
$fn$;

-- A manual invoice: lines = [{description, unitCents, quantity?, siteId?, kind?}] (+ pending charges if asked).
create or replace function public.fn_billing_create_invoice(p_actor uuid, p_actor_role text, p_platform uuid, p_lines jsonb,
  p_include_pending boolean default true, p_due_days int default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid; l jsonb;
begin
  perform public.fn_billing_owner(p_actor_role);
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'INVALID_LINES'; end if;
  if jsonb_array_length(p_lines) = 0 and not (p_include_pending and exists (
      select 1 from public.billing_charges where platform_id = p_platform and invoice_id is null and voided_at is null)) then
    raise exception 'NOTHING_TO_INVOICE';
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce(btrim(l->>'description'), '') = '' or length(l->>'description') > 200 then raise exception 'INVALID_LINES'; end if;
    if (l->>'unitCents') is null or (l->>'unitCents')::bigint = 0 then raise exception 'INVALID_LINES'; end if;
    if coalesce((l->>'quantity')::int, 1) < 1 then raise exception 'INVALID_LINES'; end if;
    if coalesce(l->>'kind', 'adjustment') not in ('adjustment','credit','addon_one_off','addon_setup') then raise exception 'INVALID_LINES'; end if;
    if nullif(l->>'siteId','') is not null and not exists (select 1 from public.sites where id = (l->>'siteId')::uuid and platform_id = p_platform) then
      raise exception 'PLATFORM_SCOPE_FORBIDDEN';
    end if;
  end loop;
  if p_due_days is not null and p_due_days not between 0 and 90 then raise exception 'INVALID_DUE_DAYS'; end if;
  v_id := public.fn_billing_issue(p_platform, 'manual', null, null, p_lines, coalesce(p_include_pending, true), p_actor, p_due_days, nullif(btrim(p_notes), ''));
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.invoice.create', 'invoice', v_id::text, jsonb_build_object('platform', p_platform));
  return v_id;
end;
$fn$;

-- A charge (positive) or credit (negative) for the platform's next invoice.
create or replace function public.fn_billing_add_charge(p_actor uuid, p_actor_role text, p_platform uuid, p_site uuid,
  p_description text, p_amount_cents bigint)
returns uuid language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid;
begin
  perform public.fn_billing_owner(p_actor_role);
  if not exists (select 1 from public.platforms where id = p_platform) then raise exception 'PLATFORM_NOT_FOUND'; end if;
  if p_amount_cents is null or p_amount_cents = 0 or abs(p_amount_cents) > 100000000000 then raise exception 'INVALID_AMOUNT'; end if;
  if coalesce(btrim(p_description), '') = '' or length(p_description) > 200 then raise exception 'INVALID_DESCRIPTION'; end if;
  if p_site is not null and not exists (select 1 from public.sites where id = p_site and platform_id = p_platform) then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, created_by)
    values (p_platform, p_site, case when p_amount_cents < 0 then 'credit' else 'adjustment' end, btrim(p_description), p_amount_cents, p_actor)
    returning id into v_id;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.charge.add', 'platform', p_platform::text, jsonb_build_object('amount_cents', p_amount_cents, 'description', p_description, 'site', p_site));
  return v_id;
end;
$fn$;

create or replace function public.fn_billing_void_charge(p_actor uuid, p_actor_role text, p_charge uuid)
returns void language plpgsql security definer set search_path = public
as $fn$
begin
  perform public.fn_billing_owner(p_actor_role);
  update public.billing_charges set voided_at = now() where id = p_charge and invoice_id is null and voided_at is null;
  if not found then raise exception 'CHARGE_NOT_PENDING'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.charge.void', 'charge', p_charge::text, '{}');
end;
$fn$;

create or replace function public.fn_billing_record_payment(p_actor uuid, p_actor_role text, p_invoice uuid, p_method text,
  p_amount_cents bigint, p_reference text, p_note text default null)
returns public.invoices language plpgsql security definer set search_path = public
as $fn$
declare v public.invoices;
begin
  perform public.fn_billing_owner(p_actor_role);
  if p_method not in ('mpesa','bank','cash','other') then raise exception 'INVALID_METHOD'; end if;
  select * into v from public.invoices where id = p_invoice for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  if v.status <> 'open' then raise exception 'INVOICE_NOT_OPEN'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_amount_cents > v.total_cents - v.amount_paid_cents then raise exception 'AMOUNT_EXCEEDS_BALANCE'; end if;
  insert into public.invoice_payments(invoice_id, platform_id, method, status, amount_cents, reference, note, recorded_by, settled_at)
    values (p_invoice, v.platform_id, p_method, 'succeeded', p_amount_cents, nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''), p_actor, now());
  v := public.fn_billing_recalc(p_invoice);
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.payment.record', 'invoice', p_invoice::text,
            jsonb_build_object('number', v.number, 'method', p_method, 'amount_cents', p_amount_cents, 'reference', p_reference));
  insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason, amount_cents, actor_id, actor_role, detail)
    select v.platform_id, ps.status, ps.status, ps.plan_key, 'payment', p_amount_cents, p_actor, p_actor_role, jsonb_build_object('invoice', v.number, 'method', p_method)
      from public.platform_subscriptions ps where ps.platform_id = v.platform_id;
  if v.status = 'paid' then
    perform public.fn_billing_notify(v.platform_id, 'success', 'Payment received for ' || v.number, public.fn_billing_kes(p_amount_cents) || ' received. Thank you.');
    perform public.fn_billing_reactivate_if_clear(v.platform_id);
  end if;
  return v;
end;
$fn$;

create or replace function public.fn_billing_set_invoice_status(p_actor uuid, p_actor_role text, p_invoice uuid, p_status text, p_reason text)
returns public.invoices language plpgsql security definer set search_path = public
as $fn$
declare v public.invoices;
begin
  perform public.fn_billing_owner(p_actor_role);
  if p_status not in ('void','uncollectible') then raise exception 'INVALID_STATUS'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into v from public.invoices where id = p_invoice for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  if v.status <> 'open' then raise exception 'INVOICE_NOT_OPEN'; end if;
  if p_status = 'void' and v.amount_paid_cents > 0 then raise exception 'INVOICE_HAS_PAYMENTS'; end if;
  if exists (select 1 from public.invoice_payments where invoice_id = p_invoice and status = 'pending') then raise exception 'PAYMENT_IN_PROGRESS'; end if;
  update public.invoices set status = p_status, voided_at = case when p_status = 'void' then now() else voided_at end,
         status_reason = btrim(p_reason), updated_at = now() where id = p_invoice returning * into v;
  -- A voided invoice releases its pending charges back to the queue (they were never billed).
  if p_status = 'void' then update public.billing_charges set invoice_id = null where invoice_id = p_invoice; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.invoice.' || p_status, 'invoice', p_invoice::text, jsonb_build_object('number', v.number, 'reason', p_reason));
  perform public.fn_billing_reactivate_if_clear(v.platform_id);
  return v;
end;
$fn$;

create or replace function public.fn_billing_set_exempt(p_actor uuid, p_actor_role text, p_platform uuid, p_exempt boolean)
returns void language plpgsql security definer set search_path = public
as $fn$
begin
  perform public.fn_billing_owner(p_actor_role);
  update public.platform_subscriptions set billing_exempt = p_exempt, updated_at = now() where platform_id = p_platform;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.exempt', 'platform', p_platform::text, jsonb_build_object('exempt', p_exempt));
end;
$fn$;

create or replace function public.fn_billing_upsert_plan(p_actor uuid, p_actor_role text, p_key text, p_name text,
  p_price_cents bigint, p_max_sites int, p_max_users int, p_active boolean)
returns void language plpgsql security definer set search_path = public
as $fn$
begin
  perform public.fn_billing_owner(p_actor_role);
  if p_key !~ '^[a-z][a-z0-9_]{1,30}$' then raise exception 'INVALID_PLAN_KEY'; end if;
  if coalesce(btrim(p_name), '') = '' or length(p_name) > 60 then raise exception 'INVALID_PLAN_NAME'; end if;
  if p_price_cents is not null and p_price_cents < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if (p_max_sites is not null and p_max_sites < 1) or (p_max_users is not null and p_max_users < 1) then raise exception 'INVALID_LIMIT'; end if;
  insert into public.subscription_plans(key, name, max_sites, max_users, price_cents, is_custom, sort, active)
    values (p_key, btrim(p_name), p_max_sites, p_max_users, p_price_cents, p_price_cents is null,
            (select coalesce(max(sort), 0) + 1 from public.subscription_plans), coalesce(p_active, true))
  on conflict (key) do update set name = excluded.name, max_sites = excluded.max_sites, max_users = excluded.max_users,
    price_cents = excluded.price_cents, is_custom = excluded.is_custom, active = excluded.active, updated_at = now();
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.plan.upsert', 'plan', p_key,
            jsonb_build_object('name', p_name, 'price_cents', p_price_cents, 'max_sites', p_max_sites, 'max_users', p_max_users, 'active', p_active));
end;
$fn$;

create or replace function public.fn_billing_settings_set(p_actor uuid, p_actor_role text, p_patch jsonb)
returns public.billing_settings language plpgsql security definer set search_path = public
as $fn$
declare v public.billing_settings;
begin
  perform public.fn_billing_owner(p_actor_role);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_SETTINGS'; end if;
  if (p_patch ? 'invoicePrefix') and (p_patch->>'invoicePrefix') !~ '^[A-Z0-9]{2,8}$' then raise exception 'INVALID_PREFIX'; end if;
  if (p_patch ? 'daysUntilDue') and ((p_patch->>'daysUntilDue')::int not between 0 and 90) then raise exception 'INVALID_DUE_DAYS'; end if;
  if (p_patch ? 'taxRateBp') and ((p_patch->>'taxRateBp')::int not between 0 and 5000) then raise exception 'INVALID_TAX'; end if;
  if (p_patch ? 'pastDueDays') and ((p_patch->>'pastDueDays')::int not between 0 and 60) then raise exception 'INVALID_DUNNING'; end if;
  if (p_patch ? 'graceDays') and ((p_patch->>'graceDays')::int not between 0 and 60) then raise exception 'INVALID_DUNNING'; end if;
  if (p_patch ? 'trialDays') and ((p_patch->>'trialDays')::int not between 0 and 90) then raise exception 'INVALID_DUNNING'; end if;
  update public.billing_settings set
    business_name        = coalesce(nullif(btrim(p_patch->>'businessName'), ''), business_name),
    business_address     = coalesce(btrim(p_patch->>'businessAddress'), business_address),
    tax_pin              = coalesce(btrim(p_patch->>'taxPin'), tax_pin),
    billing_email        = coalesce(btrim(p_patch->>'billingEmail'), billing_email),
    billing_phone        = coalesce(btrim(p_patch->>'billingPhone'), billing_phone),
    invoice_prefix       = coalesce(p_patch->>'invoicePrefix', invoice_prefix),
    days_until_due       = coalesce((p_patch->>'daysUntilDue')::int, days_until_due),
    tax_rate_bp          = coalesce((p_patch->>'taxRateBp')::int, tax_rate_bp),
    tax_label            = coalesce(nullif(btrim(p_patch->>'taxLabel'), ''), tax_label),
    payment_instructions = coalesce(btrim(p_patch->>'paymentInstructions'), payment_instructions),
    mpesa_pay_enabled    = coalesce((p_patch->>'mpesaPayEnabled')::boolean, mpesa_pay_enabled),
    footer_note          = coalesce(btrim(p_patch->>'footerNote'), footer_note),
    updated_by = p_actor, updated_at = now()
  where id returning * into v;
  update public.ops_config set
    sub_past_due_days = coalesce((p_patch->>'pastDueDays')::int, sub_past_due_days),
    sub_grace_days    = coalesce((p_patch->>'graceDays')::int, sub_grace_days),
    sub_trial_days    = coalesce((p_patch->>'trialDays')::int, sub_trial_days)
  where id;
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'billing.settings', 'billing', 'settings', p_patch);
  return v;
end;
$fn$;

-- ── 10. M-Pesa "Pay now" (System account) ───────────────────────────────────────────────────────
-- Start: a pending payment for the full balance (whole KES). The engine sends the STK push, then attaches the id.
create or replace function public.fn_billing_start_mpesa(p_actor uuid, p_actor_role text, p_invoice uuid, p_phone text)
returns table(payment_id uuid, amount_cents bigint, invoice_number text)
language plpgsql security definer set search_path = public
as $fn$
declare v public.invoices; v_due bigint; v_id uuid;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  perform public.fn_billing_assert(p_actor, p_actor_role, v.platform_id);
  if not (select mpesa_pay_enabled from public.billing_settings where id) then raise exception 'MPESA_PAY_DISABLED'; end if;
  if v.status <> 'open' then raise exception 'INVOICE_NOT_OPEN'; end if;
  if coalesce(p_phone, '') !~ '^(\+?254|0)?[17][0-9]{8}$' then raise exception 'INVALID_PHONE'; end if;
  if exists (select 1 from public.invoice_payments where invoice_id = p_invoice and status = 'pending' and created_at > now() - interval '2 minutes') then
    raise exception 'PAYMENT_IN_PROGRESS';
  end if;
  v_due := v.total_cents - v.amount_paid_cents;
  if v_due <= 0 then raise exception 'NOTHING_DUE'; end if;
  v_due := ceil(v_due / 100.0)::bigint * 100;   -- M-Pesa moves whole shillings
  insert into public.invoice_payments(invoice_id, platform_id, method, status, amount_cents, phone, recorded_by)
    values (p_invoice, v.platform_id, 'mpesa', 'pending', v_due, p_phone, p_actor) returning id into v_id;
  return query select v_id, v_due, v.number;
end;
$fn$;

create or replace function public.fn_billing_attach_checkout(p_payment uuid, p_checkout text)
returns void language sql security definer set search_path = public
as $$ update public.invoice_payments set checkout_request_id = p_checkout where id = p_payment and status = 'pending' $$;

create or replace function public.fn_billing_fail_start(p_payment uuid, p_reason text)
returns void language sql security definer set search_path = public
as $$ update public.invoice_payments set status = 'failed', failure_reason = left(p_reason, 300), settled_at = now() where id = p_payment and status = 'pending' $$;

-- Settle a VERIFIED STK result (the engine confirmed it with STKPushQuery). Idempotent: only pending moves.
create or replace function public.fn_billing_settle_mpesa(p_checkout text, p_ok boolean, p_receipt text, p_reason text, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare p public.invoice_payments; v public.invoices; v_apply bigint;
begin
  select * into p from public.invoice_payments where checkout_request_id = p_checkout for update;
  if not found then return jsonb_build_object('known', false); end if;
  if p.status <> 'pending' then return jsonb_build_object('known', true, 'applied', false, 'status', p.status, 'invoiceId', p.invoice_id); end if;
  if not p_ok then
    update public.invoice_payments set status = 'failed', failure_reason = left(coalesce(p_reason, 'Not paid'), 300), settled_at = now(), raw = p_raw where id = p.id;
    return jsonb_build_object('known', true, 'applied', false, 'status', 'failed', 'invoiceId', p.invoice_id);
  end if;
  select * into v from public.invoices where id = p.invoice_id for update;
  update public.invoice_payments set status = 'succeeded', reference = nullif(btrim(p_receipt), ''), settled_at = now(), raw = p_raw where id = p.id;
  v := public.fn_billing_recalc(p.invoice_id);
  -- Money received beyond the invoice (rounding up to whole KES, or the invoice was settled another way while
  -- the prompt was open) is kept as a credit on the platform's next invoice — never silently absorbed.
  if v.amount_paid_cents > v.total_cents then
    insert into public.billing_charges(platform_id, kind, description, amount_cents, source_ref)
      values (v.platform_id, 'credit', 'Overpayment on ' || v.number || coalesce(' (' || nullif(btrim(p_receipt), '') || ')', ''),
              -least(p.amount_cents, v.amount_paid_cents - v.total_cents), 'overpay:' || p.id::text);
  end if;
  insert into public.subscription_events(platform_id, from_status, to_status, plan_key, reason, amount_cents, detail)
    select v.platform_id, ps.status, ps.status, ps.plan_key, 'payment', p.amount_cents, jsonb_build_object('invoice', v.number, 'method', 'mpesa', 'receipt', p_receipt)
      from public.platform_subscriptions ps where ps.platform_id = v.platform_id;
  perform public.fn_billing_notify(v.platform_id, 'success', 'Payment received for ' || v.number,
    public.fn_billing_kes(p.amount_cents) || ' received by M-Pesa' || coalesce(' (' || p_receipt || ')', '') || '. Thank you.', true);
  if v.status = 'paid' then perform public.fn_billing_reactivate_if_clear(v.platform_id); end if;
  return jsonb_build_object('known', true, 'applied', true, 'status', 'succeeded', 'invoiceId', v.id, 'invoiceStatus', v.status);
end;
$fn$;

-- Is this STK checkout a billing payment? (The shared System callback URL routes here first.)
create or replace function public.fn_billing_is_checkout(p_checkout text)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.invoice_payments where checkout_request_id = p_checkout) $$;

-- Reconcile input: M-Pesa payments still pending after p_older_secs (oldest first). Rows with no checkout id
-- never reached Safaricom (the push failed mid-flight) and are closed by the engine.
create or replace function public.fn_billing_pending_mpesa(p_older_secs int, p_limit int)
returns table(payment_id uuid, checkout_request_id text, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select id, checkout_request_id, created_at from public.invoice_payments
   where method = 'mpesa' and status = 'pending' and created_at < now() - make_interval(secs => p_older_secs)
   order by created_at limit least(greatest(coalesce(p_limit, 25), 1), 100)
$$;

-- ── 11. Add-on one-off / setup fees become pending charges when a brand is granted a paid add-on ────
create or replace function public.trg_billing_addon_charge()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare a public.addon_catalog; v_platform uuid; v_site text; v_exempt boolean;
begin
  select * into a from public.addon_catalog where category = new.category and key = new.key;
  if not found or a.is_default then return new; end if;
  select s.platform_id, s.name into v_platform, v_site from public.sites s where s.id = new.site_id;
  if v_platform is null then return new; end if;
  select coalesce(billing_exempt, false) into v_exempt from public.platform_subscriptions where platform_id = v_platform;
  if coalesce(v_exempt, true) then return new; end if;
  -- Re-granting an add-on the brand already paid for (revoked, then granted again) is not charged twice.
  if exists (select 1 from public.billing_charges c where c.site_id = new.site_id and c.source_ref = new.category || ':' || new.key and c.voided_at is null) then
    return new;
  end if;
  if a.billing_type = 'one_off' and a.price_cents > 0 then
    insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, source_ref, created_by)
      values (v_platform, new.site_id, 'addon_one_off', a.display_name || ' — ' || v_site, a.price_cents, new.category || ':' || new.key, new.granted_by);
  end if;
  if a.setup_fee_cents > 0 then
    insert into public.billing_charges(platform_id, site_id, kind, description, amount_cents, source_ref, created_by)
      values (v_platform, new.site_id, 'addon_setup', a.display_name || ' setup — ' || v_site, a.setup_fee_cents, new.category || ':' || new.key, new.granted_by);
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_billing_addon_charge on public.brand_entitlements;
create trigger trg_billing_addon_charge after insert on public.brand_entitlements for each row execute function public.trg_billing_addon_charge();

-- ── 12. Reads ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_billing_settings_get(p_actor uuid, p_actor_role text)
returns jsonb language plpgsql stable security definer set search_path = public
as $fn$
declare s public.billing_settings; o record;
begin
  if p_actor_role not in ('platform_superadmin','platform_admin') then raise exception 'NOT_AUTHORIZED'; end if;
  select * into s from public.billing_settings where id;
  select sub_trial_days, sub_past_due_days, sub_grace_days into o from public.ops_config where id;
  return jsonb_build_object('businessName', s.business_name, 'businessAddress', s.business_address, 'taxPin', s.tax_pin,
    'billingEmail', s.billing_email, 'billingPhone', s.billing_phone, 'invoicePrefix', s.invoice_prefix, 'nextNumber', s.next_number,
    'daysUntilDue', s.days_until_due, 'taxRateBp', s.tax_rate_bp, 'taxLabel', s.tax_label, 'paymentInstructions', s.payment_instructions,
    'mpesaPayEnabled', s.mpesa_pay_enabled, 'footerNote', s.footer_note,
    'trialDays', o.sub_trial_days, 'pastDueDays', o.sub_past_due_days, 'graceDays', o.sub_grace_days, 'updatedAt', s.updated_at);
end;
$fn$;

create or replace function public.fn_billing_invoice_json(p_invoice uuid)
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'platformId', i.platform_id, 'platformName', p.name, 'kind', i.kind, 'status', i.status,
    'currency', i.currency, 'periodStart', i.period_start, 'periodEnd', i.period_end, 'planKey', i.plan_key,
    'issuedAt', i.issued_at, 'dueAt', i.due_at, 'subtotalCents', i.subtotal_cents, 'taxRateBp', i.tax_rate_bp, 'taxCents', i.tax_cents,
    'totalCents', i.total_cents, 'amountPaidCents', i.amount_paid_cents, 'amountDueCents', greatest(0, i.total_cents - i.amount_paid_cents),
    'paidAt', i.paid_at, 'voidedAt', i.voided_at, 'statusReason', i.status_reason, 'notes', i.notes,
    'overdue', (i.status = 'open' and i.due_at < now()),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'description', l.description, 'siteId', l.site_id,
               'siteName', s.name, 'quantity', l.quantity, 'unitCents', l.unit_cents, 'amountCents', l.amount_cents,
               'periodStart', l.period_start, 'periodEnd', l.period_end) order by l.sort)
             from public.invoice_lines l left join public.sites s on s.id = l.site_id where l.invoice_id = i.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', ip.id, 'method', ip.method, 'status', ip.status, 'amountCents', ip.amount_cents,
               'reference', ip.reference, 'phone', ip.phone, 'note', ip.note, 'failureReason', ip.failure_reason,
               'createdAt', ip.created_at, 'settledAt', ip.settled_at) order by ip.created_at desc)
             from public.invoice_payments ip where ip.invoice_id = i.id), '[]'::jsonb))
  from public.invoices i join public.platforms p on p.id = i.platform_id where i.id = p_invoice
$$;

create or replace function public.fn_billing_invoice(p_actor uuid, p_actor_role text, p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $fn$
declare v_platform uuid; s public.billing_settings;
begin
  select platform_id into v_platform from public.invoices where id = p_invoice;
  if v_platform is null then raise exception 'INVOICE_NOT_FOUND'; end if;
  perform public.fn_billing_assert(p_actor, p_actor_role, v_platform);
  select * into s from public.billing_settings where id;
  return public.fn_billing_invoice_json(p_invoice) || jsonb_build_object('seller', jsonb_build_object(
    'name', s.business_name, 'address', s.business_address, 'taxPin', s.tax_pin, 'email', s.billing_email, 'phone', s.billing_phone,
    'taxLabel', s.tax_label, 'paymentInstructions', s.payment_instructions, 'footerNote', s.footer_note, 'mpesaPayEnabled', s.mpesa_pay_enabled));
end;
$fn$;

create or replace function public.fn_billing_invoices(p_actor uuid, p_actor_role text, p_platform uuid, p_status text, p_search text, p_limit int)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $fn$
begin
  if p_actor_role = 'platform_admin' then
    p_platform := (select pr.platform_id from public.profiles pr where pr.id = p_actor);
    if p_platform is null then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  elsif p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED';
  end if;
  return query
    select jsonb_build_object('id', i.id, 'number', i.number, 'platformId', i.platform_id, 'platformName', p.name, 'kind', i.kind,
             'status', i.status, 'issuedAt', i.issued_at, 'dueAt', i.due_at, 'periodStart', i.period_start, 'periodEnd', i.period_end,
             'totalCents', i.total_cents, 'amountPaidCents', i.amount_paid_cents, 'amountDueCents', greatest(0, i.total_cents - i.amount_paid_cents),
             'overdue', (i.status = 'open' and i.due_at < now()), 'paidAt', i.paid_at)
      from public.invoices i join public.platforms p on p.id = i.platform_id
     where (p_platform is null or i.platform_id = p_platform)
       and (p_status is null or p_status = '' or (p_status = 'overdue' and i.status = 'open' and i.due_at < now()) or i.status = p_status)
       and (coalesce(p_search, '') = '' or i.number ilike '%' || p_search || '%' or p.name ilike '%' || p_search || '%')
     order by i.issued_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$fn$;

-- Every platform's billing standing (owner), or the caller's own (platform admin).
create or replace function public.fn_billing_accounts(p_actor uuid, p_actor_role text)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $fn$
declare v_own uuid;
begin
  if p_actor_role = 'platform_admin' then
    v_own := (select pr.platform_id from public.profiles pr where pr.id = p_actor);
    if v_own is null then raise exception 'PLATFORM_SCOPE_FORBIDDEN'; end if;
  elsif p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED';
  end if;
  return query
    select jsonb_build_object(
      'platformId', p.id, 'platformName', p.name, 'platformSlug', p.slug, 'planKey', ps.plan_key, 'planName', sp.name,
      'priceCents', coalesce(ps.custom_price_cents, sp.price_cents), 'customPrice', ps.custom_price_cents is not null,
      'billingPeriod', sp.billing_period, 'status', ps.status, 'billingExempt', ps.billing_exempt,
      'trialEndsAt', ps.trial_ends_at, 'currentPeriodStart', ps.current_period_start, 'currentPeriodEnd', ps.current_period_end,
      'graceEndsAt', ps.grace_ends_at, 'lastPaymentAt', ps.last_payment_at,
      'nextInvoiceAt', case when ps.billing_exempt or ps.status in ('suspended','cancelled') then null
                            when ps.status = 'trial' then ps.trial_ends_at else ps.current_period_end end,
      'monthlyAddonsCents', coalesce((select sum(ac.price_cents) from public.brand_entitlements be
                               join public.sites s on s.id = be.site_id and s.status = 'active' and s.platform_id = p.id
                               join public.addon_catalog ac on ac.category = be.category and ac.key = be.key
                              where ac.billing_type = 'monthly' and not ac.is_default), 0),
      'pendingChargesCents', coalesce((select sum(amount_cents) from public.billing_charges c where c.platform_id = p.id and c.invoice_id is null and c.voided_at is null), 0),
      'balanceDueCents', coalesce((select sum(total_cents - amount_paid_cents) from public.invoices i where i.platform_id = p.id and i.status = 'open'), 0),
      'overdueCents', coalesce((select sum(total_cents - amount_paid_cents) from public.invoices i where i.platform_id = p.id and i.status = 'open' and i.due_at < now()), 0),
      'openInvoices', (select count(*) from public.invoices i where i.platform_id = p.id and i.status = 'open'),
      'maxSites', coalesce(ps.custom_max_sites, sp.max_sites), 'maxUsers', coalesce(ps.custom_max_users, sp.max_users),
      'sites', (select count(*) from public.sites s where s.platform_id = p.id and s.status <> 'archived'),
      'users', (select count(*) from public.profiles pr join public.sites s on s.id = pr.site_id where s.platform_id = p.id and pr.role = 'player'))
    from public.platforms p
    join public.platform_subscriptions ps on ps.platform_id = p.id
    left join public.subscription_plans sp on sp.key = ps.plan_key
    where v_own is null or p.id = v_own
    order by p.name;
end;
$fn$;

create or replace function public.fn_billing_pending_charges(p_actor uuid, p_actor_role text, p_platform uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $fn$
begin
  perform public.fn_billing_assert(p_actor, p_actor_role, p_platform);
  return query
    select jsonb_build_object('id', c.id, 'kind', c.kind, 'description', c.description, 'siteId', c.site_id, 'siteName', s.name,
             'amountCents', c.amount_cents, 'createdAt', c.created_at)
      from public.billing_charges c left join public.sites s on s.id = c.site_id
     where c.platform_id = p_platform and c.invoice_id is null and c.voided_at is null order by c.created_at;
end;
$fn$;

-- Owner revenue dashboard.
create or replace function public.fn_billing_overview(p_actor uuid, p_actor_role text)
returns jsonb language plpgsql stable security definer set search_path = public
as $fn$
declare v_mrr bigint; v_now timestamptz := now(); v_month timestamptz := date_trunc('month', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
begin
  perform public.fn_billing_owner(p_actor_role);
  select coalesce(sum(case when sp.billing_period = 'year' then coalesce(ps.custom_price_cents, sp.price_cents) / 12 else coalesce(ps.custom_price_cents, sp.price_cents) end), 0)
       + coalesce((select sum(ac.price_cents) from public.brand_entitlements be
                    join public.sites s on s.id = be.site_id and s.status = 'active'
                    join public.platform_subscriptions ps2 on ps2.platform_id = s.platform_id and not ps2.billing_exempt and ps2.status in ('active','past_due','grace_period')
                    join public.addon_catalog ac on ac.category = be.category and ac.key = be.key
                   where ac.billing_type = 'monthly' and not ac.is_default), 0)
    into v_mrr
    from public.platform_subscriptions ps join public.subscription_plans sp on sp.key = ps.plan_key
   where not ps.billing_exempt and ps.status in ('active','past_due','grace_period');
  return jsonb_build_object(
    'mrrCents', v_mrr, 'arrCents', v_mrr * 12,
    'outstandingCents', coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open'), 0),
    'overdueCents', coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at < v_now), 0),
    'collectedThisMonthCents', coalesce((select sum(amount_cents) from public.invoice_payments where status = 'succeeded' and settled_at >= v_month), 0),
    'collectedLastMonthCents', coalesce((select sum(amount_cents) from public.invoice_payments where status = 'succeeded'
                                          and settled_at >= v_month - interval '1 month' and settled_at < v_month), 0),
    'aging', jsonb_build_object(
      'current', coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at >= v_now), 0),
      'd1_30',   coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at < v_now and due_at >= v_now - interval '30 days'), 0),
      'd31_60',  coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at < v_now - interval '30 days' and due_at >= v_now - interval '60 days'), 0),
      'd61_90',  coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at < v_now - interval '60 days' and due_at >= v_now - interval '90 days'), 0),
      'd90p',    coalesce((select sum(total_cents - amount_paid_cents) from public.invoices where status = 'open' and due_at < v_now - interval '90 days'), 0)),
    'statusCounts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.platform_subscriptions where not billing_exempt group by status) x), '{}'::jsonb),
    'upcoming', coalesce((select jsonb_agg(x order by x->>'at') from (
        select jsonb_build_object('platformId', p.id, 'platformName', p.name,
                 'at', case when ps.status = 'trial' then ps.trial_ends_at else ps.current_period_end end,
                 'amountCents', coalesce(ps.custom_price_cents, sp.price_cents, 0)) x
          from public.platform_subscriptions ps join public.platforms p on p.id = ps.platform_id left join public.subscription_plans sp on sp.key = ps.plan_key
         where not ps.billing_exempt and ps.status in ('trial','active','past_due','grace_period')
           and (case when ps.status = 'trial' then ps.trial_ends_at else ps.current_period_end end) between v_now and v_now + interval '14 days') y), '[]'::jsonb),
    'recentPayments', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', ip.id, 'invoiceId', ip.invoice_id, 'number', i.number, 'platformName', p.name, 'method', ip.method,
                 'amountCents', ip.amount_cents, 'reference', ip.reference, 'settledAt', ip.settled_at) x
          from public.invoice_payments ip join public.invoices i on i.id = ip.invoice_id join public.platforms p on p.id = ip.platform_id
         where ip.status = 'succeeded' order by ip.settled_at desc limit 8) y), '[]'::jsonb));
end;
$fn$;

-- ── 13. Grants: service_role only ───────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'fn_billing_assert(uuid,text,uuid)', 'fn_billing_owner(text)', 'fn_billing_notify(uuid,text,text,text,boolean)', 'fn_billing_kes(bigint)',
    'fn_billing_next_number()', 'fn_billing_recalc(uuid)', 'fn_billing_renewal_billable(uuid)', 'fn_billing_reactivate_if_clear(uuid)',
    'fn_billing_issue(uuid,text,timestamptz,timestamptz,jsonb,boolean,uuid,int,text)', 'fn_billing_run(timestamptz)', 'fn_billing_run_now(uuid,text)',
    'fn_billing_create_invoice(uuid,text,uuid,jsonb,boolean,int,text)', 'fn_billing_add_charge(uuid,text,uuid,uuid,text,bigint)',
    'fn_billing_void_charge(uuid,text,uuid)', 'fn_billing_record_payment(uuid,text,uuid,text,bigint,text,text)',
    'fn_billing_set_invoice_status(uuid,text,uuid,text,text)', 'fn_billing_set_exempt(uuid,text,uuid,boolean)',
    'fn_billing_upsert_plan(uuid,text,text,text,bigint,int,int,boolean)', 'fn_billing_settings_set(uuid,text,jsonb)',
    'fn_billing_start_mpesa(uuid,text,uuid,text)', 'fn_billing_attach_checkout(uuid,text)', 'fn_billing_fail_start(uuid,text)',
    'fn_billing_settle_mpesa(text,boolean,text,text,jsonb)', 'fn_billing_is_checkout(text)', 'fn_billing_pending_mpesa(int,int)', 'fn_billing_settings_get(uuid,text)', 'fn_billing_invoice_json(uuid)',
    'fn_billing_invoice(uuid,text,uuid)', 'fn_billing_invoices(uuid,text,uuid,text,text,int)', 'fn_billing_accounts(uuid,text)',
    'fn_billing_pending_charges(uuid,text,uuid)', 'fn_billing_overview(uuid,text)', 'trg_billing_addon_charge()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$g$;
