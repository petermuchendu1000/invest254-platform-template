-- 0203_marketer_peer_transfer.sql — marketer-to-marketer funny-money transfer (docs/63, BUGLOG #140).
--
-- WHY. A marketer's till wallet holds SIMULATED money (docs/27 — their game money is structurally
-- non-withdrawable and never enters the real-cash economy). When one ran out the only ways to get
-- more were an admin crediting them (fn_marketer_credit, admin-gated) or the capped self top-up
-- (fn_marketer_demo_topup). Both put a ceiling or a person in the way of something no real cash
-- passes through. This adds the missing path: a marketer sends some of their own float to a
-- colleague on the SAME brand.
--
-- IT IS ONE FUNCTION, NOT TWO CALLS. A credit + a withdraw issued from the API would be two
-- transactions: a crash between them destroys or duplicates funny money, and no amount of
-- application retry logic can make two statements atomic from outside. The debit, the credit and
-- BOTH ledger rows happen here, in one transaction, under row locks.
--
-- BALANCE ONLY — FULIZA IS NOT SPENDABLE ON A TRANSFER, and that is a deliberate difference from
-- fn_marketer_withdraw (0033), which does let Fuliza cover a shortfall. Fuliza here is an
-- admin-granted overdraft (fn_marketer_set_fuliza) that nothing ever repays: available_fuliza_cents
-- only ever goes down on spend and back up when an operator resets it. A WITHDRAWAL spending it
-- takes money OUT of the system, so the overdraft is consumed and the story ends. A TRANSFER
-- spending it would move the borrowed amount into another live wallet — minting funny money that no
-- operator granted, and letting two marketers ratchet the float up indefinitely by taking turns.
-- So the sender's cash balance is the only source. (Reversing this is one condition below; see
-- docs/63 if the owner decides the realism is worth the supply leak.)
--
-- SAME BRAND ONLY, with a DELIBERATELY OPAQUE refusal. A marketer of brand A sending to brand B
-- raises RECIPIENT_NOT_FOUND — the SAME error as a number nobody holds — so neither this function
-- nor the route above it can be used to discover which brand a number belongs to. That matches the
-- recipient-lookup route's single refusal and extends 0199's brand fence to the one money path a
-- marketer can start on their own.
--
-- DEADLOCK. Two marketers sending to each other at the same instant is the textbook deadlock: each
-- locks its own wallet, then waits for the other's. The two wallets are therefore locked in a FIXED
-- order (by marketer_id), never in sender-then-recipient order, so concurrent opposing transfers
-- queue instead of deadlocking.
--
-- IDEMPOTENT on p_ref. marketer_ledger has a UNIQUE index on ref (0033), so the two rows this writes
-- cannot share one: they are stored as '<ref>:out' and '<ref>:in'. The idempotency probe reads the
-- ':out' row, which is written in the same transaction as the ':in' row, so either both exist or
-- neither does. A phone that retries a timed-out send therefore cannot send twice.
--
-- Idempotent as a MIGRATION too (create or replace + a guarded constraint swap), and deploy-order
-- safe: the migrate job runs before the API deploys, and no existing caller references this.

begin;

-- ── 1) The ledger has to be able to say what these rows are ─────────────────────────────────────
-- 0033 constrained entry_type to credit|withdrawal|adjustment|reversal. A transfer is neither a
-- credit (nobody paid the marketer) nor a withdrawal (nothing left the system), and recording it as
-- either would make every statement and every report that groups by entry_type wrong. Two new
-- values, added by swapping the CHECK — additive, so every existing row still satisfies it.
do $$
begin
  alter table public.marketer_ledger drop constraint if exists marketer_ledger_entry_type_check;
  alter table public.marketer_ledger
    add constraint marketer_ledger_entry_type_check
    check (entry_type in ('credit','withdrawal','adjustment','reversal','transfer_out','transfer_in'));
end $$;

-- Covers the daily-cap probe below: the sender's own outgoing transfers in a time window.
create index if not exists ix_marketer_ledger_transfer_out
  on public.marketer_ledger(marketer_id, created_at desc)
  where entry_type = 'transfer_out';

-- ── 2) The transfer ─────────────────────────────────────────────────────────────────────────────
-- Returns jsonb:
--   { idempotent, from_balance_cents, to_balance_cents, out_ledger_id, in_ledger_id,
--     recipient_name, sent_cents }
--
-- p_daily_cap_cents bounds how much ONE sender may move in a rolling 24 hours. The funny-money
-- supply is a policy number, and peer transfer is a new way to concentrate it in one wallet; the
-- API passes the policy value (MARKETER_TRANSFER_DAILY_CAP_CENTS) exactly as it passes the top-up
-- cap. The default here is not "unlimited" on purpose — an omitted cap is still a cap.
create or replace function public.fn_marketer_transfer(
  p_from_marketer_id uuid,
  p_to_marketer_id   uuid,
  p_amount_cents     bigint,
  p_ref              text   default null,
  p_meta             jsonb  default '{}'::jsonb,
  p_daily_cap_cents  bigint default 10000000      -- KES 100,000 / rolling 24h
)
returns jsonb
language plpgsql
as $func$
declare
  v_from_site uuid; v_to_site uuid;
  v_from_status text; v_to_status text;
  v_from_name text;  v_to_name text;
  v_from_bal bigint; v_to_bal bigint;
  v_new_from bigint; v_new_to bigint;
  v_sent_today bigint;
  v_out_id bigint;   v_in_id bigint;
  v_ref_out text := nullif(p_ref, '') || ':out';
  v_ref_in  text := nullif(p_ref, '') || ':in';
  ex public.marketer_ledger;
  lock_first uuid; lock_second uuid;
begin
  -- ── Shape of the request ──────────────────────────────────────────────────────────────────────
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'AMOUNT_MUST_BE_POSITIVE';
  end if;
  -- A sub-shilling transfer is not a thing a person does; it is a loop writing ledger rows.
  if p_amount_cents < 100 then
    raise exception 'AMOUNT_BELOW_MINIMUM';
  end if;
  if p_from_marketer_id is null or p_to_marketer_id is null then
    raise exception 'MARKETER_NOT_FOUND';
  end if;
  -- Checked BEFORE anything is locked or read: sending to yourself would otherwise lock one wallet
  -- twice and net to zero after writing two ledger rows that claim money moved.
  if p_from_marketer_id = p_to_marketer_id then
    raise exception 'TRANSFER_TO_SELF';
  end if;

  -- ── Already done? ─────────────────────────────────────────────────────────────────────────────
  -- Probed before the locks so a retry of a completed transfer costs nothing and blocks nobody.
  if p_ref is not null and p_ref <> '' then
    select * into ex from public.marketer_ledger where ref = v_ref_out;
    if found then
      return jsonb_build_object(
        'idempotent', true,
        'from_balance_cents', ex.balance_after_cents,
        'to_balance_cents', (select balance_cents from public.marketer_wallets where marketer_id = p_to_marketer_id),
        'out_ledger_id', ex.id,
        'in_ledger_id', (select id from public.marketer_ledger where ref = v_ref_in),
        'recipient_name', (select name from public.marketers where id = p_to_marketer_id),
        'sent_cents', -ex.amount_cents);
    end if;
  end if;

  -- ── Who are these two? ────────────────────────────────────────────────────────────────────────
  select site_id, status, name into v_from_site, v_from_status, v_from_name
    from public.marketers where id = p_from_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  if v_from_status <> 'active' then raise exception 'MARKETER_NOT_ACTIVE:%', v_from_status; end if;

  select site_id, status, name into v_to_site, v_to_status, v_to_name
    from public.marketers where id = p_to_marketer_id;
  -- Every reason the recipient is unusable collapses into ONE error: no such marketer, another
  -- brand's marketer, or a suspended one. Telling them apart would make this a way to map numbers
  -- to brands, which is exactly what the lookup route refuses to do.
  if not found or v_to_site is distinct from v_from_site or v_to_status <> 'active' then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;

  -- ── How much has this sender already moved today? ─────────────────────────────────────────────
  -- Rolling 24 hours rather than a calendar day: the brands span time zones and a calendar cap
  -- would reset at an hour that means nothing to the marketer holding the phone.
  if p_daily_cap_cents is not null and p_daily_cap_cents >= 0 then
    select coalesce(sum(-amount_cents), 0) into v_sent_today
      from public.marketer_ledger
     where marketer_id = p_from_marketer_id
       and entry_type = 'transfer_out'
       and created_at > now() - interval '24 hours';
    if v_sent_today + p_amount_cents > p_daily_cap_cents then
      raise exception 'TRANSFER_DAILY_CAP: sent %, cap %', v_sent_today, p_daily_cap_cents;
    end if;
  end if;

  -- ── Lock BOTH wallets, in a fixed order ───────────────────────────────────────────────────────
  -- By marketer_id, never sender-then-recipient: two marketers sending to each other at the same
  -- instant would otherwise each hold one wallet and wait for the other's.
  if p_from_marketer_id < p_to_marketer_id then
    lock_first := p_from_marketer_id; lock_second := p_to_marketer_id;
  else
    lock_first := p_to_marketer_id;   lock_second := p_from_marketer_id;
  end if;
  perform 1 from public.marketer_wallets where marketer_id = lock_first  for update;
  perform 1 from public.marketer_wallets where marketer_id = lock_second for update;

  select balance_cents into v_from_bal from public.marketer_wallets where marketer_id = p_from_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  select balance_cents into v_to_bal   from public.marketer_wallets where marketer_id = p_to_marketer_id;
  if not found then raise exception 'RECIPIENT_NOT_FOUND'; end if;

  -- CASH ONLY. available_fuliza_cents is deliberately not consulted — see the header.
  if v_from_bal < p_amount_cents then
    raise exception 'INSUFFICIENT_FUNDS: have %, need %', v_from_bal, p_amount_cents;
  end if;

  v_new_from := v_from_bal - p_amount_cents;
  v_new_to   := v_to_bal   + p_amount_cents;

  update public.marketer_wallets set balance_cents = v_new_from, updated_at = now()
   where marketer_id = p_from_marketer_id;
  update public.marketer_wallets set balance_cents = v_new_to,   updated_at = now()
   where marketer_id = p_to_marketer_id;

  -- ── The two halves of the record ──────────────────────────────────────────────────────────────
  -- `meta.name` is the COUNTERPARTY's name on each side, because that is what the app's
  -- confirmation builder reads (ledgerToTxDto -> mpesaSentMessage / mpesaReceivedMessage): the
  -- sender's statement says "sent to PETER MUCHENDU", the recipient's says "received from TONY
  -- ANGWA". `meta.source` marks the pair so a report can find both halves. No phone number is
  -- stored in meta: the app is never given anyone's number but its own (docs/58) and a column
  -- nobody reads is still a column that leaks when someone does.
  insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
  values (p_from_marketer_id, 'transfer_out', -p_amount_cents, v_new_from, v_ref_out,
          coalesce(p_meta,'{}'::jsonb) || jsonb_build_object(
            'source', 'marketer_transfer', 'name', v_to_name,
            'counterparty_marketer_id', p_to_marketer_id))
  returning id into v_out_id;

  insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
  values (p_to_marketer_id, 'transfer_in', p_amount_cents, v_new_to, v_ref_in,
          coalesce(p_meta,'{}'::jsonb) || jsonb_build_object(
            'source', 'marketer_transfer', 'name', v_from_name,
            'counterparty_marketer_id', p_from_marketer_id))
  returning id into v_in_id;

  return jsonb_build_object(
    'idempotent', false,
    'from_balance_cents', v_new_from,
    'to_balance_cents', v_new_to,
    'out_ledger_id', v_out_id,
    'in_ledger_id', v_in_id,
    'recipient_name', v_to_name,
    'sent_cents', p_amount_cents);
end
$func$;

-- PostgREST surface (0153): this moves money and must never be reachable with the public anon key.
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from public;
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from anon;
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from authenticated;

commit;
