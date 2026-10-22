-- 0207_marketer_email_and_airtime.sql — a marketer's own email, and airtime bought from the wallet.
--
-- TWO THINGS, ONE MIGRATION, because they answer the same complaint: docs/65 shipped a statement
-- that could not be emailed to anybody (no address existed anywhere) and could not report a
-- purchase (nothing recorded one). This closes both.
--
-- ── 1. THE EMAIL ──────────────────────────────────────────────────────────────────────────────
--
-- `marketers` had no email column and neither does `profiles`, so docs/65 §5 had the marketer type
-- an address every time they wanted a statement sent. They now set it once, on their own dashboard.
--
-- NOT UNIQUE. Two marketers sharing one address is a real arrangement — a supervisor who receives
-- their team's statements, a shop with one inbox — and a unique index would refuse it for no
-- benefit, since the address authenticates nothing. The phone remains the identity.
--
-- The CHECK is a BACKSTOP, not the validation. The API validates properly (isDeliverableEmail);
-- this only stops a direct psql UPDATE storing something that is obviously not an address.
--
-- ── 2. AIRTIME ────────────────────────────────────────────────────────────────────────────────
--
-- The marketer app's airtime screen was local-only: it added to a number in handset memory and no
-- ledger row was ever written (docs/65 §4). So the wallet said one thing and the statement said
-- nothing. fn_marketer_buy_airtime makes it a real movement:
--
--   balance_cents  -= amount        (the money leaves the cash bucket)
--   airtime_balance_cents += amount (and arrives in the airtime bucket)
--   one ledger row, entry_type 'airtime', amount_cents = -amount
--
-- CONSERVING, not destroying: the funny money moves between two buckets of the same wallet and the
-- total the marketer holds is unchanged. That is what makes the statement's arithmetic work — the
-- row is a debit from the balance, which is what the statement reports on.
--
-- CASH ONLY — Fuliza cannot buy airtime, and that is deliberate. The owner's words were "buy credit
-- FROM THEIR MPESA BALANCE". It is also the same rule as a transfer (0203): this Fuliza is an
-- admin-granted overdraft that nothing ever repays, so spending it here would mint airtime no
-- operator granted. (A WITHDRAWAL may still spend it, because that money leaves the system and the
-- story ends. Airtime does not leave.)
--
-- ONE ROW, NOT TWO. A credit row for the airtime bucket would double-count the movement in every
-- total: the statement sums signed amount_cents against balance_after_cents, and airtime is not
-- part of the balance. The single debit is the whole truth about the cash.
--
-- IDEMPOTENT on p_ref, like every other money path here — marketer_ledger has a UNIQUE index on
-- ref (0033), so a retried purchase cannot buy twice.
--
-- Idempotent as a migration, additive, and deploy-order safe: nothing existing calls either function.

begin;

-- ── 1. The email ───────────────────────────────────────────────────────────────────────────────
alter table public.marketers add column if not exists email text;

do $$
begin
  alter table public.marketers drop constraint if exists marketers_email_shape_check;
  alter table public.marketers
    add constraint marketers_email_shape_check
    check (email is null or (length(email) between 6 and 254 and email like '%_@_%.__%'));
end $$;

-- Self-service: the marketer sets their OWN address. No actor, no brand fence — the subject is the
-- caller, which the route has already authenticated. Returns the stored value so the caller never
-- has to guess what normalisation did.
create or replace function public.fn_marketer_set_email(
  p_marketer_id uuid,
  p_email       text
)
returns text
language plpgsql
as $func$
declare
  v_clean text := nullif(btrim(lower(coalesce(p_email, ''))), '');
  v_status text;
begin
  select status into v_status from public.marketers where id = p_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  if v_status <> 'active' then raise exception 'MARKETER_NOT_ACTIVE:%', v_status; end if;

  -- Lower-cased and trimmed on the way in, so "Faith@Example.COM " and "faith@example.com" are the
  -- same stored address and a statement is never sent to a near-duplicate of the intended inbox.
  if v_clean is not null and (length(v_clean) < 6 or length(v_clean) > 254 or v_clean not like '%_@_%.__%') then
    raise exception 'INVALID_EMAIL';
  end if;

  update public.marketers set email = v_clean, updated_at = now() where id = p_marketer_id;
  return v_clean;
end
$func$;

-- The profile view the API reads. Re-created with `email` APPENDED LAST, which is the only shape
-- `create or replace view` permits and the precedent 0096 and 0198 both set: every by-name consumer
-- is unaffected, and a positional one would have broken on 0198 already.
create or replace view public.marketer_profiles
  with (security_invoker = true) as
select
  m.id,
  m.name,
  public.fn_first_name(m.name) as first_name,
  public.fn_initials(m.name)   as initials,
  m.phone,
  m.status,
  w.balance_cents,
  w.available_fuliza_cents,
  w.airtime_balance_cents,
  w.currency,
  w.updated_at as wallet_updated_at,
  m.created_at,
  m.site_id,
  s.name as brand_name,
  m.sessions_valid_after,
  m.email
from public.marketers m
join public.marketer_wallets w on w.marketer_id = m.id
left join public.sites s on s.id = m.site_id;

-- ── 2. Airtime ─────────────────────────────────────────────────────────────────────────────────
-- 0203 widened entry_type to add the transfer pair; this adds the one a purchase needs. Additive,
-- so every existing row still satisfies it.
do $$
begin
  alter table public.marketer_ledger drop constraint if exists marketer_ledger_entry_type_check;
  alter table public.marketer_ledger
    add constraint marketer_ledger_entry_type_check
    check (entry_type in ('credit','withdrawal','adjustment','reversal','transfer_out','transfer_in','airtime'));
end $$;

-- Returns jsonb:
--   { idempotent, balance_cents, airtime_balance_cents, ledger_id, created_at }
--
-- p_min_cents is the policy floor, passed by the API rather than fixed here: a sub-shilling airtime
-- purchase is not a thing a person does, it is a loop writing ledger rows.
create or replace function public.fn_marketer_buy_airtime(
  p_marketer_id uuid,
  p_amount_cents bigint,
  p_ref          text  default null,
  p_meta         jsonb default '{}'::jsonb,
  p_min_cents    bigint default 500        -- KES 5
)
returns jsonb
language plpgsql
as $func$
declare
  v_status text;
  v_bal bigint; v_air bigint;
  v_new_bal bigint; v_new_air bigint;
  v_id bigint; v_at timestamptz;
  ex public.marketer_ledger;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'AMOUNT_MUST_BE_POSITIVE';
  end if;
  if p_amount_cents < greatest(coalesce(p_min_cents, 500), 1) then
    raise exception 'AMOUNT_BELOW_MINIMUM: min %', greatest(coalesce(p_min_cents, 500), 1);
  end if;
  if p_marketer_id is null then raise exception 'MARKETER_NOT_FOUND'; end if;

  -- Already done? Probed before the lock, so a retry of a completed purchase costs nothing.
  if p_ref is not null and p_ref <> '' then
    select * into ex from public.marketer_ledger where ref = p_ref;
    if found then
      return jsonb_build_object(
        'idempotent', true,
        'balance_cents', ex.balance_after_cents,
        'airtime_balance_cents', (select airtime_balance_cents from public.marketer_wallets where marketer_id = p_marketer_id),
        'ledger_id', ex.id,
        'created_at', to_char(ex.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
  end if;

  select status into v_status from public.marketers where id = p_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  if v_status <> 'active' then raise exception 'MARKETER_NOT_ACTIVE:%', v_status; end if;

  perform 1 from public.marketer_wallets where marketer_id = p_marketer_id for update;
  select balance_cents, airtime_balance_cents into v_bal, v_air
    from public.marketer_wallets where marketer_id = p_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;

  -- CASH ONLY. available_fuliza_cents is deliberately not consulted — see the header.
  if v_bal < p_amount_cents then
    raise exception 'INSUFFICIENT_FUNDS: have %, need %', v_bal, p_amount_cents;
  end if;

  v_new_bal := v_bal - p_amount_cents;
  v_new_air := v_air + p_amount_cents;

  update public.marketer_wallets
     set balance_cents = v_new_bal, airtime_balance_cents = v_new_air, updated_at = now()
   where marketer_id = p_marketer_id;

  -- `meta.target_masked` is the number the airtime went to, MASKED at write time. The marketer
  -- typed it, so it is theirs to spend on; but the statement it lands in gets forwarded, and this
  -- ledger deliberately stores no full counterparty number anywhere (docs/58, 0203). Masked is the
  -- version that answers "who did this credit go to?" without becoming a directory.
  insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
  values (p_marketer_id, 'airtime', -p_amount_cents, v_new_bal, nullif(p_ref, ''),
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'airtime_purchase'))
  returning id, created_at into v_id, v_at;

  return jsonb_build_object(
    'idempotent', false,
    'balance_cents', v_new_bal,
    'airtime_balance_cents', v_new_air,
    'ledger_id', v_id,
    'created_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end
$func$;

-- ── 3. The statement has to know what an 'airtime' row is ──────────────────────────────────────
-- Replaced wholesale (0206's body, one branch added) so the bucket mapping lives in exactly one
-- place. AIRTIME IS "OTHERS", which is where a real M-PESA statement counts an airtime purchase:
-- it is neither a till nor a pay bill, and the reference's eight rows have nowhere else for it.
-- The DETAIL row says "Airtime Purchase" in as many words, which is where the answer actually is.
create or replace function public.fn_marketer_statement_summary(
  p_marketer_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns jsonb
language sql
stable
as $func$
  with scoped as (
    select
      case
        when l.entry_type = 'transfer_out' then 'SEND MONEY'
        when l.entry_type = 'transfer_in'  then 'RECEIVED MONEY'
        when l.entry_type = 'withdrawal'   then 'AGENT WITHDRAWAL'
        when l.entry_type = 'credit'
         and coalesce(l.meta->>'source','') not in ('game_withdrawal','game_withdrawal_approved')
                                           then 'AGENT DEPOSIT'
        else 'OTHERS'
      end                                                         as bucket,
      greatest(l.amount_cents, 0)                                 as paid_in,
      greatest(-l.amount_cents, 0)                                as paid_out
    from public.marketer_ledger l
    where l.marketer_id = p_marketer_id
      and l.created_at >= p_from
      and l.created_at <  p_to
  ),
  totals as (
    select b.bucket,
           coalesce(sum(s.paid_in), 0)::bigint  as paid_in,
           coalesce(sum(s.paid_out), 0)::bigint as paid_out
      from (values ('SEND MONEY'), ('RECEIVED MONEY'), ('AGENT DEPOSIT'),
                   ('AGENT WITHDRAWAL'), ('OTHERS')) as b(bucket)
      left join scoped s on s.bucket = b.bucket
     group by b.bucket
  )
  select jsonb_build_object(
    'buckets', (select jsonb_object_agg(bucket, jsonb_build_object('in', paid_in, 'out', paid_out)) from totals),
    'txn_count', (select count(*) from scoped),
    'paid_in_cents', (select coalesce(sum(paid_in), 0) from totals),
    'paid_out_cents', (select coalesce(sum(paid_out), 0) from totals)
  );
$func$;

-- PostgREST surface (0153 / BUGLOG #143). fn_marketer_buy_airtime moves money and
-- fn_marketer_set_email writes to a profile; neither may ever be reachable with the public anon key.
revoke all on function public.fn_marketer_set_email(uuid, text) from public;
revoke all on function public.fn_marketer_set_email(uuid, text) from anon;
revoke all on function public.fn_marketer_set_email(uuid, text) from authenticated;
revoke all on function public.fn_marketer_buy_airtime(uuid, bigint, text, jsonb, bigint) from public;
revoke all on function public.fn_marketer_buy_airtime(uuid, bigint, text, jsonb, bigint) from anon;
revoke all on function public.fn_marketer_buy_airtime(uuid, bigint, text, jsonb, bigint) from authenticated;
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from public;
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.fn_marketer_statement_summary(uuid, timestamptz, timestamptz) from authenticated;

commit;
