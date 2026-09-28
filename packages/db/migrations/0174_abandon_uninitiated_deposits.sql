-- 0174_abandon_uninitiated_deposits.sql — a deposit the gateway REFUSED must not linger as `pending`.
--
-- THE BUG. Every initiate path creates the transaction row BEFORE calling the gateway:
--
--     txId = createDepositProvider(...)        -- row is now `pending`
--     res  = client.initiateStk(...)           -- <-- throws: gateway refused
--     attachStk(txId, res...)                  -- never reached
--
-- so a refusal leaves a row that is `pending` with `checkout_request_id IS NULL` FOREVER. Nothing
-- settles it: the callback never fires (there is no checkout id to key on) and the reconcile sweep
-- matches on that same id. 199 such rows had accumulated, across every rail.
--
-- No money is ever at risk in one — the row is created before the gateway call, so no STK prompt
-- reached a player and no `ledger_entries` exist (verified: 0 for all 199). The damage is
-- operational: the deposits queue fills with ghosts, and a real failure looks like a stuck payment.
--
-- WHAT TRIGGERED THE CLEAN-UP. PayHero began answering `initiateStk` with
--   400 {"error_code":"BAD_REQUEST","error_message":"The merchant has been blocked for spamming"}
-- when deposits were fired in bursts (six in 27 seconds). Their block is transient — a deposit
-- succeeded 39 seconds after a rejection, and 37 succeeded that day — but every rejection minted
-- another ghost. The throttle that stops provoking it lives in the service layer; this migration
-- makes the AFTERMATH correct no matter which gateway refuses, or why.
--
-- Additive + idempotent. Money-neutral by construction: the function cannot touch wallets or the
-- ledger, and it REFUSES any row that actually reached the gateway.
begin;

-- ── The guard rail: close out a deposit that never reached the gateway ────────────────────────────
-- Deliberately narrow. It will only act on a row that is
--   * still pending/processing  (never re-opens or re-writes a settled deposit), AND
--   * has no `checkout_request_id` (proof the gateway never accepted it), AND
--   * has no ledger entries     (belt and braces — such a row cannot have any, but if one ever did,
--                                money moved and this is not ours to close).
-- Anything else returns false and is left exactly as it is.
create or replace function public.fn_abandon_deposit(p_tx uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare v_ok boolean;
begin
  update public.transactions t
     set status = 'failed',
         result_code = coalesce(t.result_code, 1),
         result_desc = left(coalesce(p_reason, 'abandoned:gateway_refused'), 200)
   where t.id = p_tx
     and t.kind = 'deposit'
     and t.status in ('pending', 'processing')
     and t.checkout_request_id is null
     and not exists (select 1 from public.ledger_entries le
                      where le.ref_table = 'transactions' and le.ref_id = t.id::text)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$fn$;

revoke all on function public.fn_abandon_deposit(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_abandon_deposit(uuid, text) to service_role;

-- ── Close out the ghosts already in the table ────────────────────────────────────────────────────
-- Same three conditions as the function, so this can never close a deposit that reached a gateway
-- or moved money. `result_desc` marks them as a backfill so they are distinguishable in reporting
-- from deposits the gateway genuinely failed.
update public.transactions t
   set status = 'failed',
       result_code = coalesce(t.result_code, 1),
       result_desc = 'abandoned:never_initiated:0174'
 where t.kind = 'deposit'
   and t.status in ('pending', 'processing')
   and t.checkout_request_id is null
   and not exists (select 1 from public.ledger_entries le
                    where le.ref_table = 'transactions' and le.ref_id = t.id::text);

commit;

-- REVERT (manual, if ever needed):
--   drop function if exists public.fn_abandon_deposit(uuid, text);
--   -- the backfill is not reversed: those rows never reached a gateway and hold no money, so
--   -- `failed` is their truthful terminal state. They are identifiable by
--   --   result_desc = 'abandoned:never_initiated:0174'
