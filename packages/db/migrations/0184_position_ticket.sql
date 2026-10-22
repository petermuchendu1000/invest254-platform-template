-- 0184_position_ticket.sql — MetaTrader's ticket: the number a trader quotes when they ask about a trade.
--
-- WHY: `positions.id` is a uuid, so every surface that names a trade printed its first eight hex
-- characters: `86373d49` in the Trade grid, `#2fc6b2f2` on the close form, `#97ab312c` in the phone's
-- order result. MetaTrader's ticket is a short ascending integer (`328674`, docs/mt5/09-toolbox.md
-- 313; `Close #328906 …`, 01-order-and-close-dialogs.md 155). A hex fragment is not a ticket: it does
-- not order, it cannot be read out over a phone call to support, and it is the one identifier a
-- trader is ever asked for.
--
-- A SEQUENCE DEFAULT, not a separate UPDATE. The other display columns on this table (entry_price,
-- exit_price, symbol) are stamped after the atomic money RPC returns, because computing them needs
-- the day's price axis, which the RPC has no business knowing. A ticket needs nothing: the default
-- fires inside the same INSERT `fn_open_position` already performs, and because the function names
-- its columns explicitly and does not name this one, its ten-argument signature is untouched. That
-- matters for the reason migration 0182 spells out: adding a defaulted PARAMETER would create an
-- overload and make every existing call ambiguous, whereas a defaulted COLUMN is invisible to it.
--
-- So the money path is unchanged, the ticket can never be missing on a new row, and it is monotonic
-- without the engine having to allocate anything.
--
-- Starting at 100000 so a ticket reads like MetaTrader's six-figure one from the first trade rather
-- than counting up from 1, and so the backfill below cannot collide with a live allocation.
create sequence if not exists public.position_ticket_seq as bigint start with 100000;

alter table public.positions
  add column if not exists ticket bigint;

-- Existing rows get tickets in the order they were opened, so history reads chronologically and an
-- older trade always carries a lower number than a newer one. Done before the DEFAULT is attached so
-- the backfill draws from the same sequence and the next live trade continues from where it stopped.
update public.positions p
   set ticket = nextval('public.position_ticket_seq')
  from (select id from public.positions where ticket is null order by opened_at, id) o
 where p.id = o.id
   and p.ticket is null;

alter table public.positions
  alter column ticket set default nextval('public.position_ticket_seq');

-- Unique rather than merely indexed: a ticket a trader quotes has to identify ONE trade. Not NOT
-- NULL, because that would rewrite the table and because a row inserted by some path that predates
-- this column should surface as a missing ticket rather than fail to open a position.
create unique index if not exists positions_ticket_key on public.positions (ticket);

comment on column public.positions.ticket is
  'MetaTrader-style ticket: a short ascending integer a trader can quote. Filled by position_ticket_seq as a column DEFAULT, so fn_open_position is untouched. Display identity only; nothing in settlement reads it.';
