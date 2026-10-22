import type { PositionDto, TransactionDto } from '../api/types.js';

/**
 * The data model behind MetaTrader 5's History screen.
 *
 * MetaTrader splits one trade into three records, and shows each on its own tab:
 *
 *   ORDERS     the REQUEST — "buy 1.00 XAUUSD", which was either filled or cancelled
 *   DEALS      the EXECUTIONS — one `in` deal when the contract opens, one `out` deal when it
 *              settles, plus `balance` deals for deposits and withdrawals
 *   POSITIONS  the round trip — entry, exit, and what it paid
 *
 * That is not a presentation trick: a contract here really does have a placement, two executions and
 * a settled round trip, each with its own time, and this module derives all three from the records
 * the API already serves. Nothing is invented — a field we do not have is not drawn (see
 * `EXECUTION_PRICE` below).
 *
 * Every function here is pure so the screen's arithmetic can be tested without a browser.
 */

/** Deals and positions of a contract are both reported against the one instrument we quote. */
export type Side = 'buy' | 'sell';

export type HistoryTab = 'positions' | 'orders' | 'deals';

/**
 * What a price slot reads when there is no price to print.
 *
 * MetaTrader prints an execution price on a deal and an entry→exit pair on a position. Those are
 * prices on the chart's axis, and the axis is re-anchored every UTC day by the engine, so a trade's
 * curve rate cannot be turned back into the number the player saw — only the engine's day chain
 * knows each day's anchor. So the engine stamps the price at execution time
 * (`PositionDto.entryPrice` / `exitPrice`, migration 0180) and these screens print it.
 *
 * A trade placed before that column existed has no price, and rather than map its old rate through
 * TODAY's anchor and print a number that never happened, its slots fall back to this — which is
 * both true (every contract here is market-executed) and MetaTrader's own wording for it.
 */
export const EXECUTION_PRICE = 'at market';

/**
 * A price as the symbol quotes it: fixed to the instrument's digits, thousands grouped.
 *
 * Falls back to EXECUTION_PRICE for an unstamped trade, so every caller gets a printable string and
 * none of them has to decide what a missing price looks like.
 */
export function priceText(price: number | null | undefined, digits: number): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) return EXECUTION_PRICE;
  return price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The UTC trade date a timestamp falls on — the day the chart's price axis is anchored to. */
export const tradeDateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * May a rate recorded at `atMs` be rendered as a price against an axis anchored on `anchorDate`?
 *
 * Only when they are the same UTC day. The engine re-anchors the axis at every UTC midnight, so a
 * rate from an earlier day mapped through today's anchor yields a price that never happened —
 * silently, and plausibly enough that nobody would notice. Anywhere this says no, the surface shows
 * EXECUTION_PRICE instead of a number it cannot know.
 */
export const priceKnown = (atMs: number, anchorDate: string | null | undefined): boolean =>
  typeof anchorDate === 'string' && anchorDate.length > 0 && tradeDateOf(atMs) === anchorDate;

// ───────────────────────────────── period ─────────────────────────────────

/** MetaTrader's period menu, in its order. */
export type PeriodKey = 'all' | 'today' | 'week' | 'month' | 'quarter' | 'custom';

export const PERIODS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last week' },
  { key: 'month', label: 'Last month' },
  { key: 'quarter', label: 'Last 3 months' },
  { key: 'custom', label: 'Custom period' },
];

/**
 * The DESKTOP period presets, which are a different list from the mobile five above.
 *
 * docs/mt5/09-toolbox.md 667-677 reads them off `history.png`: four entries, Title Case, and
 * "There is no 'Today', no 'Last 3 days', no 'Last week'" on desktop. 683-685 records the mobile
 * list as "different again", so the two lists coexist rather than one replacing the other, and
 * `PERIODS` stays the mobile History screen's.
 *
 * No entry carries a tick in the published menu, unlike the view-mode block right above it
 * (:658), so which one opens selected is the caller's decision rather than a reading.
 */
export const DESKTOP_PERIODS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: 'all', label: 'All History' },
  { key: 'quarter', label: 'Last 3 Months' },
  { key: 'month', label: 'Last Month' },
  { key: 'custom', label: 'Custom Period' },
];

export interface Range {
  fromMs: number;
  toMs: number;
}

const DAY_MS = 86_400_000;

/** Local midnight at the start of the day containing `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The window a period covers, as [fromMs, toMs).
 *
 * MetaTrader's presets run back from the start of today and include today, so "Last week" is the
 * seven days ending now — which is what its own subtitle (2017.08.11 - 2017.08.18) spells out.
 */
export function periodRange(key: PeriodKey, nowMs: number, custom?: Partial<Range>): Range {
  const today = startOfDay(nowMs);
  const toMs = today + DAY_MS;
  switch (key) {
    // `All History` (09-toolbox.md 670) has no start: every record the account has ever held.
    case 'all':
      return { fromMs: 0, toMs };
    case 'today':
      return { fromMs: today, toMs };
    case 'week':
      return { fromMs: today - 6 * DAY_MS, toMs };
    case 'month':
      return { fromMs: today - 29 * DAY_MS, toMs };
    case 'quarter':
      return { fromMs: today - 89 * DAY_MS, toMs };
    case 'custom': {
      // An unset end means "up to now"; an unset start means "from the beginning". A range entered
      // backwards is read in the order the player meant, not dropped.
      const a = custom?.fromMs ?? 0;
      const b = custom?.toMs ?? toMs;
      return a <= b ? { fromMs: a, toMs: b } : { fromMs: b, toMs: a };
    }
  }
}

/** The subtitle MetaTrader prints under each period name. */
export function periodSubtitle(r: Range): string {
  const last = r.toMs - 1;
  const from = dateOnly(r.fromMs);
  const to = dateOnly(last);
  return from === to ? from : `${from} - ${to}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * MetaTrader's date format: 2017.06.07, on the LOCAL day.
 *
 * Local because its only caller is `periodSubtitle`, which names the window `periodRange` built out
 * of local midnights. A record's own time is a different thing and is stamped in server time — see
 * `stamp`.
 */
export function dateOnly(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/**
 * A record's time, as MetaTrader's Time column prints one: `2017.06.07 11:51:19`.
 *
 * Format from docs/mt5/09-toolbox.md 289-291 — "The record is represented as YYYY.MM.DD HH:MM" —
 * plus the seconds the same lines record the rendered values as carrying (`2026.06.22 14:49:50`).
 *
 * The zone is the other half of that sentence: "Specified according to the time zone of the broker's
 * trading server." The broker here is this platform's own engine, and its day is UTC — the chart's
 * price axis is re-anchored at every UTC midnight, which is what `tradeDateOf` reads. So a record is
 * stamped in UTC on every surface, rather than in whatever zone the browser happens to sit in, which
 * would move one trade's stamp between two of the same trader's devices.
 */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ───────────────────────────────── rows ─────────────────────────────────

/** A row on the ORDERS tab: the request, and whether it was filled. */
export interface OrderRow {
  id: string;
  ticket: string;
  symbol: string;
  side: Side;
  /** Requested volume and filled volume, which differ only on a cancelled order. */
  lots: string;
  filledLots: string;
  atMs: number;
  /** When the request was placed, and when the position it opened closed (null if it never did). */
  openMs: number;
  closeMs: number | null;
  state: 'FILLED' | 'CANCELED';
  /** The price it filled at; null on a cancelled order, and on a trade placed before 0180. */
  price: number | null;
}

/** A row on the DEALS tab. `balance` deals are deposits and withdrawals, as in MetaTrader. */
export interface DealRow {
  id: string;
  ticket: string;
  kind: 'trade' | 'balance';
  symbol: string;
  side: Side | null;
  entry: 'in' | 'out' | null;
  lots: string | null;
  label: string | null;
  atMs: number;
  /** The round trip this execution belongs to. A balance deal is both at once; it has no duration. */
  openMs: number;
  closeMs: number | null;
  /** Set on `out` deals and on balance deals; an `in` deal has no result yet. */
  amountCents: number | null;
  /** The price this execution happened at — entry on an `in` deal, exit on an `out` one. */
  price: number | null;
  /**
   * The price the round trip OPENED at, carried on both of its deals.
   *
   * The pair to `openMs`, and there for the same reason: MetaTrader's `Change` column is "a
   * percentage change in the asset price at the time when profit/loss is locked in"
   * (09-toolbox.md 636), which is a figure over the whole round trip, so an `out` deal cannot
   * state it from its own exit price alone.
   */
  openPrice: number | null;
}

/**
 * A row on the POSITIONS tab: the settled round trip.
 *
 * MetaTrader paints a coloured stripe down a row that closed on a stop loss or a take profit. No row
 * here earns one: a contract settles at expiry, which is neither, and a stripe on every win and loss
 * would turn a specific signal into decoration.
 */
export interface PositionRow {
  id: string;
  ticket: string;
  kind: 'trade' | 'balance';
  symbol: string;
  side: Side | null;
  lots: string | null;
  label: string | null;
  atMs: number;
  /** The round trip's two times, which is what History's `Open time` and `Close time` sort on. */
  openMs: number;
  closeMs: number | null;
  amountCents: number | null;
  /** The round trip's two prices. Both null on a balance operation, which has no price at all. */
  entryPrice: number | null;
  exitPrice: number | null;
}

/**
 * The stand-in ticket for a record that genuinely has no number of its own.
 *
 * A BALANCE operation is the only such record left: a deposit or a withdrawal is a transaction, not
 * a position, and nothing allocates it a ticket. MetaTrader does give balance deals a ticket, so
 * this keeps the column populated and the row identifiable rather than blank, but it is a uuid
 * fragment and is labelled as one here so nobody mistakes it for a number a trader can quote.
 */
export const ticketOf = (id: string): string => id.replace(/-/g, '').slice(0, 8);

/**
 * A position's ticket: MetaTrader's own, the short ascending integer from migration 0184.
 *
 * The fallback is for a row written before that column existed and never backfilled. The migration
 * backfills every row it finds, in opening order, so in practice this cannot be reached; it is here
 * so a history grid pointed at an older database still identifies its rows instead of printing a
 * column of dashes.
 */
export const positionTicket = (p: PositionDto): string =>
  p.ticket === null || p.ticket === undefined ? ticketOf(p.id) : String(p.ticket);

const inRange = (ms: number, r: Range) => ms >= r.fromMs && ms < r.toMs;

/** Only money that actually moved counts: a pending or failed deposit is not a balance operation. */
export const isCompleted = (t: TransactionDto): boolean => {
  const s = t.status.toLowerCase();
  return s === 'completed' || s === 'success' || s === 'succeeded' || s === 'credited' || s === 'paid';
};

/** Signed effect of a transaction on the balance. */
export const signedCents = (t: TransactionDto): number =>
  t.kind === 'withdrawal' ? -Math.abs(t.amountCents) : Math.abs(t.amountCents);

export function orderRows(
  positions: readonly PositionDto[],
  range: Range,
  /** The brand's own symbol, used when a row does not carry its own (see migration 0182). */
  symbol: string,
  lotsOf: (stakeCents: number) => string,
): OrderRow[] {
  const out: OrderRow[] = [];
  for (const p of positions) {
    if (!inRange(p.openedAt, range)) continue;
    // A void contract is a request that never became a trade — MetaTrader's CANCELED, which fills
    // nothing. Everything else was executed in full the moment it was placed.
    const canceled = p.result === 'void';
    out.push({
      id: p.id,
      ticket: positionTicket(p),
      // The instrument this order was for (migration 0182). The parameter is the FALLBACK, for a
      // row written before the column existed, which means the brand's own symbol.
      symbol: p.symbol ?? symbol,
      side: p.direction,
      lots: lotsOf(p.stakeCents),
      filledLots: canceled ? lotsOf(0) : lotsOf(p.stakeCents),
      atMs: p.openedAt,
      openMs: p.openedAt,
      closeMs: p.settledAt,
      state: canceled ? 'CANCELED' : 'FILLED',
      price: canceled ? null : p.entryPrice ?? null,
    });
  }
  return out;
}

export function dealRows(
  positions: readonly PositionDto[],
  transactions: readonly TransactionDto[],
  range: Range,
  symbol: string,
  lotsOf: (stakeCents: number) => string,
): DealRow[] {
  const out: DealRow[] = [];
  for (const p of positions) {
    if (p.result === 'void') continue; // never executed, so there is no deal
    const lots = lotsOf(p.stakeCents);
    if (inRange(p.openedAt, range)) {
      out.push({
        id: `${p.id}:in`, ticket: positionTicket(p), kind: 'trade', symbol: p.symbol ?? symbol,
        side: p.direction, entry: 'in', lots, label: null, atMs: p.openedAt, amountCents: null,
        openMs: p.openedAt, closeMs: p.settledAt, price: p.entryPrice ?? null,
        openPrice: p.entryPrice ?? null,
      });
    }
    // Closing a BUY is a sell execution, and vice versa — MetaTrader reports the deal's own
    // direction, not the position's.
    if (p.settledAt !== null && inRange(p.settledAt, range)) {
      out.push({
        id: `${p.id}:out`, ticket: positionTicket(p), kind: 'trade', symbol: p.symbol ?? symbol,
        side: p.direction === 'buy' ? 'sell' : 'buy', entry: 'out', lots, label: null,
        atMs: p.settledAt, openMs: p.openedAt, closeMs: p.settledAt,
        amountCents: p.pnlCents, price: p.exitPrice ?? null,
        openPrice: p.entryPrice ?? null,
      });
    }
  }
  for (const t of transactions) {
    if (!isCompleted(t) || !inRange(t.ts, range)) continue;
    out.push({
      id: `tx:${t.id}`, ticket: ticketOf(t.id), kind: 'balance', symbol: 'Balance',
      side: null, entry: null, lots: null,
      label: t.kind === 'withdrawal' ? 'Withdrawal' : 'Deposit',
      atMs: t.ts, openMs: t.ts, closeMs: t.ts, amountCents: signedCents(t), price: null,
      openPrice: null,
    });
  }
  return out;
}

export function positionRows(
  positions: readonly PositionDto[],
  transactions: readonly TransactionDto[],
  range: Range,
  symbol: string,
  lotsOf: (stakeCents: number) => string,
): PositionRow[] {
  const out: PositionRow[] = [];
  for (const p of positions) {
    // A position exists once it has closed; an open contract lives on the Trade tab, as in
    // MetaTrader, and a void one never opened at all.
    if (p.settledAt === null || p.result === 'void') continue;
    if (!inRange(p.settledAt, range)) continue;
    out.push({
      id: p.id, ticket: positionTicket(p), kind: 'trade', symbol: p.symbol ?? symbol,
      side: p.direction, lots: lotsOf(p.stakeCents), label: null,
      atMs: p.settledAt, openMs: p.openedAt, closeMs: p.settledAt, amountCents: p.pnlCents,
      entryPrice: p.entryPrice ?? null, exitPrice: p.exitPrice ?? null,
    });
  }
  for (const t of transactions) {
    if (!isCompleted(t) || !inRange(t.ts, range)) continue;
    out.push({
      id: `tx:${t.id}`, ticket: ticketOf(t.id), kind: 'balance', symbol: 'Balance',
      side: null, lots: null, label: t.kind === 'withdrawal' ? 'Withdrawal' : 'Deposit',
      atMs: t.ts, openMs: t.ts, closeMs: t.ts, amountCents: signedCents(t),
      entryPrice: null, exitPrice: null,
    });
  }
  return out;
}

// ───────────────────────────────── summaries ─────────────────────────────────

export interface OrdersSummary {
  filled: number;
  canceled: number;
  total: number;
}

export function ordersSummary(rows: readonly OrderRow[]): OrdersSummary {
  let filled = 0;
  for (const r of rows) if (r.state === 'FILLED') filled++;
  return { filled, canceled: rows.length - filled, total: rows.length };
}

/**
 * MetaTrader's money summary: Profit, Deposit, Balance.
 *
 * Its Swap and Commission lines are omitted, exactly as MetaTrader omits them when they are zero —
 * and here they are STRUCTURALLY zero: a contract settles at expiry so it is never held overnight
 * (no swap), and the house margin is inside the payout rather than charged per trade (no
 * commission). `balance` is the period's net effect, which is what MetaTrader totals there — not the
 * wallet's current figure.
 */
export interface MoneySummary {
  profitCents: number;
  depositCents: number;
  balanceCents: number;
}

export function moneySummary(rows: ReadonlyArray<{ kind: 'trade' | 'balance'; amountCents: number | null }>): MoneySummary {
  let profitCents = 0;
  let depositCents = 0;
  for (const r of rows) {
    if (r.amountCents === null) continue;
    if (r.kind === 'balance') depositCents += r.amountCents;
    else profitCents += r.amountCents;
  }
  return { profitCents, depositCents, balanceCents: profitCents + depositCents };
}

/**
 * The DESKTOP Toolbox History summary strip, which is a different line from `moneySummary`.
 *
 * docs/mt5/09-toolbox.md 722-739 gives five fields in this order and defines each verbatim:
 * "Profit — profit or loss relative to the initial deposit / Credit — amount credited by the
 * brokerage company / Deposit — deposit of the account (the sum of balance type operations with a
 * positive value) / Withdrawal — amount withdrawn from the account (the sum of balance type
 * operations with a negative value)", and "The current account balance is displayed at the end of
 * the line". So Deposit and Withdrawal are the two SIGNED halves of the balance operations, where
 * `moneySummary` nets them into one Deposit figure for the mobile screen's three-line summary.
 *
 * CREDIT is structurally zero here and is still printed, because MetaTrader prints it as `0.00`
 * in its own screenshot (:725) rather than dropping it: a credit is money the broker lends the
 * account, and this platform lends none. The field is a fact about the account, not a gap.
 *
 * Balance is the three added up, which is exactly how MetaTrader's own strip adds up
 * (591.31 + 3 000.00 - 250.00 = 3 341.31 at :725) — it is the account's balance over the period
 * the strip is describing, not the wallet's figure today, which would disagree with the rows
 * above it whenever the period is not All History.
 */
export interface HistoryStrip {
  profitCents: number;
  creditCents: number;
  depositCents: number;
  withdrawalCents: number;
  balanceCents: number;
}

export function historyStrip(
  rows: ReadonlyArray<{ kind: 'trade' | 'balance'; amountCents: number | null }>,
): HistoryStrip {
  let profitCents = 0;
  let depositCents = 0;
  let withdrawalCents = 0;
  for (const r of rows) {
    if (r.amountCents === null) continue;
    if (r.kind !== 'balance') profitCents += r.amountCents;
    else if (r.amountCents >= 0) depositCents += r.amountCents;
    else withdrawalCents += r.amountCents;
  }
  return {
    profitCents,
    creditCents: 0,
    depositCents,
    withdrawalCents,
    balanceCents: profitCents + depositCents + withdrawalCents,
  };
}

/**
 * MetaTrader's `Change` column: the percentage the ASSET PRICE moved over the round trip.
 *
 * 09-toolbox.md 636 defines it as "a percentage change in the asset price at the time when
 * profit/loss is locked in", which is the price's own move and not the trade's result — so a
 * winning SELL prints a negative Change, and that is right rather than a sign bug.
 *
 * Null wherever either end is unknown: a trade placed before the engine stamped execution prices
 * (migration 0180) has no price to measure, and an invented percentage would be worse than a
 * blank cell.
 */
export function priceChangePct(from: number | null, to: number | null): number | null {
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** `2.18 %` / `-0.01 %` — the spacing MetaTrader's own cells carry (09-toolbox.md 645). */
export function changeText(pct: number | null): string {
  return pct === null ? '' : `${pct.toFixed(2)} %`;
}

// ───────────────────────────────── sorting ─────────────────────────────────

/**
 * The HISTORY screen's sort menu, which is its own list and not the Trade tab's.
 *
 * docs/mt5/04-mobile-app.md 422: Android's History sort button offers `Symbol · Ticket · Open time ·
 * Close time · Profit`, while "the Trade tab's sort offers symbol, ticket, time, profit". This
 * screen used to show the Trade tab's four, so a trader on History could not sort by either of the
 * two times the tab is about. A history record really does have both: a contract has an `openedAt`
 * and a `settledAt`, which is what `openMs` and `closeMs` carry.
 */
export type SortKey = 'symbol' | 'ticket' | 'opentime' | 'closetime' | 'profit';

export const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'ticket', label: 'Ticket' },
  { key: 'opentime', label: 'Open time' },
  { key: 'closetime', label: 'Close time' },
  { key: 'profit', label: 'Profit' },
];

interface Sortable {
  symbol: string;
  ticket: string;
  atMs: number;
  /** When the contract opened. */
  openMs?: number | undefined;
  /** When it closed, or null for a record that has no close: a cancelled order, an entry deal. */
  closeMs?: number | null | undefined;
  amountCents?: number | null;
}

/**
 * Sorted copy. `ascending` is MetaTrader's arrow direction; the default view is newest first, which
 * is time DESCENDING. Ties fall back to the row's own time so the order is stable and reproducible.
 *
 * A row with no close time sorts on the one time it has rather than being pushed to an end, because
 * a cancelled order is not older or newer than a settled one, it simply never closed.
 */
/**
 * Compare two tickets the way a trader expects them ordered.
 *
 * MetaTrader's tickets are integers, and sorting them as text puts `1000000` before `999999` the
 * moment the sequence crosses a digit boundary, which is the one thing a ticket sort must not do.
 * Numbers therefore compare as numbers; a balance operation's uuid fragment is not a number, so it
 * falls back to text and sorts after the real tickets rather than interleaving with them.
 */
function compareTickets(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a !== '' && Number.isFinite(na);
  const bNum = b !== '' && Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.localeCompare(b);
}

export function sortRows<T extends Sortable>(rows: readonly T[], key: SortKey, ascending: boolean): T[] {
  const dir = ascending ? 1 : -1;
  const timeOf = (r: Sortable): number =>
    key === 'opentime' ? r.openMs ?? r.atMs : (key === 'closetime' ? r.closeMs ?? r.atMs : r.atMs);
  const out = rows.slice();
  out.sort((a, b) => {
    let d = 0;
    if (key === 'symbol') d = a.symbol.localeCompare(b.symbol);
    else if (key === 'ticket') d = compareTickets(a.ticket, b.ticket);
    else if (key === 'profit') d = (a.amountCents ?? 0) - (b.amountCents ?? 0);
    else d = timeOf(a) - timeOf(b);
    if (d !== 0) return dir * d;
    return b.atMs - a.atMs;
  });
  return out;
}
