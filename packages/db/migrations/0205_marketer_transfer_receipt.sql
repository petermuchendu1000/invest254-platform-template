-- 0205_marketer_transfer_receipt.sql — give a peer transfer a receipt the two sides agree on.
--
-- WHY. 0203 returns enough to settle the MONEY (balances, ledger ids, the recipient's name) but
-- nothing a RECEIPT can be printed from. The app now shows the sender a confirmation screen and a
-- downloadable M-PESA receipt, and both carry two facts 0203 does not hand back:
--
--   1. WHEN it happened. The device clock is not an acceptable source. It can be wrong, it can be
--      deliberately set, and — the case that actually bites — on an idempotent retry the phone is
--      asking about a transfer that completed MINUTES ago, so "now" would print a time the money
--      did not move. The commit time of the out-row is the only honest answer, and only the
--      database knows it.
--   2. WHAT IT IS CALLED. The M-PESA confirmation code. The API derives it from (commit time,
--      out-ledger id) with the same mpesaCode() that renders the transaction list, so the code on
--      the receipt is the code the sender will later find in their statement. That only works if
--      both inputs survive a retry, which is exactly what returning them from here guarantees:
--      ex.id and ex.created_at of the row that was already written, never a fresh value.
--
-- BOTH SIDES, ONE CODE. Real M-PESA gives the payer and the payee the same confirmation code; this
-- replica gave them two, because ledgerToTxDto derives the code from each row's OWN id and the two
-- halves of a transfer are two rows. The in-row now carries `meta.pair_ledger_id` = the out-row's
-- id, so the recipient's feed can render the sender's code. The timestamps already match: both rows
-- default created_at to now(), which in Postgres is transaction start — identical for the pair.
-- Rows written by 0203 before this have no pair_ledger_id and keep falling back to their own id, so
-- nothing already rendered changes.
--
-- NOTHING ELSE MOVES. Same signature, same refusal order, same locks, same cash-only rule, same cap,
-- same opaque RECIPIENT_NOT_FOUND. This is `create or replace` of 0203's body with two extra output
-- fields and one extra meta key; re-read it against 0203 before changing either.
--
-- Idempotent as a migration, and deploy-order safe: the API tolerates a missing out_created_at
-- (it falls back to its own clock), so the old API against this function and this function against
-- the old API both work — which is what makes migrate-then-deploy safe in either order.

begin;

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
  v_out_at timestamptz;
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
  -- `out_created_at` comes from the STORED row, so a retry reprints the original receipt rather
  -- than minting a second one with today's time and a different code.
  if p_ref is not null and p_ref <> '' then
    select * into ex from public.marketer_ledger where ref = v_ref_out;
    if found then
      return jsonb_build_object(
        'idempotent', true,
        'from_balance_cents', ex.balance_after_cents,
        'to_balance_cents', (select balance_cents from public.marketer_wallets where marketer_id = p_to_marketer_id),
        'out_ledger_id', ex.id,
        'in_ledger_id', (select id from public.marketer_ledger where ref = v_ref_in),
        'out_created_at', to_char(ex.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
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

  -- CASH ONLY. available_fuliza_cents is deliberately not consulted — see 0203's header.
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
  returning id, created_at into v_out_id, v_out_at;

  -- `pair_ledger_id` points the IN-row at the out-row, so the confirmation code the recipient sees
  -- is the one the sender sees. Without it each side derives a code from its own id and one
  -- transaction has two names — which no real M-PESA transfer does. Only the in-row carries it:
  -- on the out-row it would point at itself, which is what the fallback already does.
  insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
  values (p_to_marketer_id, 'transfer_in', p_amount_cents, v_new_to, v_ref_in,
          coalesce(p_meta,'{}'::jsonb) || jsonb_build_object(
            'source', 'marketer_transfer', 'name', v_from_name,
            'counterparty_marketer_id', p_from_marketer_id,
            'pair_ledger_id', v_out_id))
  returning id into v_in_id;

  return jsonb_build_object(
    'idempotent', false,
    'from_balance_cents', v_new_from,
    'to_balance_cents', v_new_to,
    'out_ledger_id', v_out_id,
    'in_ledger_id', v_in_id,
    'out_created_at', to_char(v_out_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'recipient_name', v_to_name,
    'sent_cents', p_amount_cents);
end
$func$;

-- PostgREST surface (0153 / BUGLOG #143): this moves money and must never be reachable with the
-- public anon key. `create or replace` preserves the existing ACL, so these are belt to 0203's
-- braces — and the thing that keeps the CI function-grants gate green if this is ever re-created
-- from scratch on a fresh database.
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from public;
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from anon;
revoke all on function public.fn_marketer_transfer(uuid, uuid, bigint, text, jsonb, bigint) from authenticated;

commit;
