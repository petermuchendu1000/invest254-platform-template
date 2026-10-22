'use client';

import { useState } from 'react';
import { formatKes } from '@invest254/shared/money';
import { FitText } from '@/components/ui/FitText';
import { useMarketerMoney } from '@/lib/affiliate/hooks';
import type { MarketerMoneyRange } from '@/lib/api/types';

/**
 * The marketer's money, as a real table, filterable by time range.
 *
 * Replaces the overflowing KPI tiles and the free-form statement card with two aligned, tabular
 * tables — one WINDOWED, one LIFETIME — because the money on this page is of two different kinds and
 * the old layout gave the reader no way to tell them apart.
 *
 * ── WHY TWO TABLES, AND HOW THE TRUST ANCHOR SURVIVES A RANGE FILTER ───────────────────────────
 *
 * "Available to withdraw" is a LIFETIME balance. It is `fn_commission_balance(p_user)`, whose
 * signature takes only a user id and whose arithmetic is, verbatim (migration 0105:41-43):
 *
 *     earned − held − paid − expenses, floored at 0
 *       earned   = Σ deposit_commissions.commission_amount where beneficiary_role='marketer' and status='accrued'
 *       held     = Σ commission_payouts.amount_cents where status in ('requested','approved')
 *       paid     = Σ commission_payouts.amount_cents where status='paid'
 *       expenses = Σ marketer_expenses.amount_cents          (the FULL sum — fn_marketer_expenses_total, 0121)
 *
 * There is no ranged variant of that function, and there should not be: a "7-day available" is not
 * money anybody can withdraw. So a windowed table placed under a lifetime hero figure WILL be read
 * as contradicting it — "I earned 4,000 this month but it says 850 available" — unless the two are
 * visibly, structurally separate. This is how that is solved here:
 *
 *   1. The two tables are SEPARATE TABLES with separate captions, each carrying an explicit scope
 *      pill: "Period" on the windowed one, "Lifetime · not filtered" on the ladder.
 *   2. The range filter sits INSIDE the windowed table's header and is visibly absent from the
 *      lifetime one, so the control's reach is obvious.
 *   3. The windowed table never ends on a line called "Available". Its closing line is
 *      "Net in period", a period subtotal. Only the lifetime table ends on "Available to withdraw",
 *      and that line renders the SAME number the hero renders.
 *   4. The lifetime ladder is computed from the props this component is handed — the very values the
 *      hero is drawn from (`/me/referral` + the full expense sum) — NOT from the money endpoint's
 *      own `lifetime` block, even though the two are the same SQL. One fetch, one number: the hero
 *      and the ladder cannot disagree because they are the same variables.
 *   5. A footnote states the relationship in words, and when the range is "All time" it says so
 *      explicitly, because that is the one case where the windowed earned/expenses figures DO equal
 *      the ladder's first two lines and the reader deserves to be told that is expected.
 *
 * ── BUGLOG #23 ────────────────────────────────────────────────────────────────────────────────
 * Every total below arrives as a server-side SQL aggregate over the whole range. Nothing here sums a
 * `commissions`/`expenses`/`advances` array — those are limit-capped display pages, and summing one
 * silently under-counts past the limit (the recorded case: 150 expense rows reported 10,000 against
 * a true 59,000). The one derived figure, "Net in period", is the difference of two full aggregates.
 *
 * ── 320px ─────────────────────────────────────────────────────────────────────────────────────
 * `table-fixed` + percentage column widths + `min-w-0`/`truncate` labels + `FitText` amounts: the
 * label yields, the number is always shown in full, and no figure can widen the page into a
 * horizontal scroll (the failure mode of the `grid-cols-2` KPI tiles this replaces). The range
 * control is `text-base` so iOS does not zoom the page when it takes focus.
 */

/** The filter's windows. `7d`/`30d`/`90d`/`180d` are TRAILING N days ending today (inclusive),
 *  matching `periodRange` in lib/history/mt5history.ts — not calendar-to-date. */
const RANGES: ReadonlyArray<{ key: MarketerMoneyRange; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 3 months' },
  { key: '180d', label: 'Last 6 months' },
  { key: 'all', label: 'All time' },
];

/** Expense categories as the dashboard already labels them (migration 0068's category strings). */
const EXPENSE_LABELS: Readonly<Record<string, string>> = {
  tiktok_promo: 'TikTok promo', data_bundles: 'Data bundles', advance: 'Advance payment',
  airtime: 'Airtime', transport: 'Transport', other: 'Other',
};
/** Advance statuses, worded as the Activity ledger's badges word them. */
const ADVANCE_LABELS: Readonly<Record<string, string>> = {
  requested: 'pending', approved: 'approved', rejected: 'declined', cancelled: 'cancelled',
};

export interface MarketerMoneyTableProps {
  enabled: boolean;
  /** LIFETIME figures, passed in from the same query the hero is drawn from so the ladder and the
   *  hero are literally the same numbers. All cents. */
  lifetime: {
    earnedCents: number;
    expensesCents: number;
    paidCents: number;
    heldCents: number;
    availableCents: number;
  };
}

export function MarketerMoneyTable({ enabled, lifetime }: MarketerMoneyTableProps) {
  // Default: today. The range is part of the react-query key (see useMarketerMoney) so two filter
  // states never share one cache entry and a figure is never shown under another range's label.
  const [range, setRange] = useState<MarketerMoneyRange>('today');
  const money = useMarketerMoney(range, enabled);
  const label = RANGES.find((r) => r.key === range)?.label ?? 'Today';

  const w = money.data?.window;
  const netInPeriod = (w?.earnedCents ?? 0) - (w?.expensesCents ?? 0);

  // The lifetime ladder, exactly as the statement has always computed it:
  //   netAfterExpenses = earned − expenses        (a labelled waterfall subtotal, may be negative)
  //   available        = max(earned − expenses − paid − held, 0)   <- the SQL figure, floored
  const netAfterExpenses = lifetime.earnedCents - lifetime.expensesCents;
  const netPosition = netAfterExpenses - lifetime.paidCents - lifetime.heldCents;

  /**
   * The lines behind the period figures, merged newest-first.
   *
   * An APPROVED advance exists twice in the data — once as a `marketer_advance_requests` row and
   * once as the `marketer_expenses` row (category 'advance') that the approval logs and that is what
   * actually reduces the withdrawable (migration 0122:94-103). Only the expense copy is listed here,
   * so the money appears exactly once; an advance request is listed only while it has NOT become an
   * expense (requested / rejected / cancelled), and then as a status line with no signed amount.
   */
  const lines = [
    ...(money.data?.commissions ?? []).map((c) => ({
      key: `c-${c.id}`, atMs: c.createdAtMs, tone: 'up' as const,
      what: `${c.referredUsername ?? 'Referred deposit'} · ${Math.round(c.rate * 100)}% of ${formatKes(c.depositAmountCents)}`,
      amount: `+${formatKes(c.commissionCents)}`,
    })),
    ...(money.data?.expenses ?? []).map((e) => ({
      key: `e-${e.id}`, atMs: e.createdAtMs, tone: 'down' as const,
      what: `${EXPENSE_LABELS[e.category] ?? e.category.replace(/_/g, ' ')}${e.note ? ` · ${e.note}` : ''}`,
      amount: `−${formatKes(e.amountCents)}`,
    })),
    ...(money.data?.advances ?? [])
      .filter((a) => a.status !== 'approved')
      .map((a) => ({
        key: `a-${a.id}`, atMs: a.createdAtMs, tone: undefined,
        what: `Advance ${ADVANCE_LABELS[a.status]}${a.reason ? ` · ${a.reason}` : ''}`,
        amount: formatKes(a.amountCents),
      })),
  ].sort((a, b) => b.atMs - a.atMs);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      {/* ── WINDOWED ─────────────────────────────────────────────────────────────────────────── */}
      <div className="min-w-0 rounded-2xl border border-border bg-surface-2">
        <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 xs:flex-row xs:items-center xs:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">Money</h3>
            <ScopePill>Period</ScopePill>
          </div>
          {/* A native select: one control, no overflow at 320px, and `text-base` keeps iOS from
              zooming the page when it takes focus. */}
          <label className="flex min-w-0 items-center gap-2">
            <span className="sr-only">Time range</span>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as MarketerMoneyRange)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-base text-fg outline-none focus:border-accent xs:flex-none sm:text-sm"
            >
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
        </div>

        <table className="w-full table-fixed border-collapse text-left">
          <caption className="px-3 pt-2 text-left text-[11px] text-muted">
            What happened in this period{money.data?.from ? <> · {money.data.from}{money.data.to && money.data.to !== money.data.from ? ` → ${money.data.to}` : ''} (EAT)</> : null}
          </caption>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted">
              <th scope="col" className="w-[52%] px-3 py-1.5 font-medium">Line</th>
              <th scope="col" className="w-[16%] px-1 py-1.5 text-right font-medium tabular-nums">Items</th>
              <th scope="col" className="w-[32%] px-3 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {money.isLoading && !money.data ? (
              <SkeletonRows />
            ) : money.isError ? (
              <tr><td colSpan={3} className="px-3 py-3 text-center text-xs text-muted">Couldn&apos;t load this period.</td></tr>
            ) : (
              <>
                <MoneyRow label="Commission earned" count={w?.earnedCount} amount={w?.earnedCents ?? 0} sign="+" tone="up" />
                {(w?.otherCommissionCents ?? 0) > 0 ? (
                  <MoneyRow
                    label="Other commission"
                    hint="Instant player commission already paid to your wallet — it does not fund your marketer balance."
                    amount={w?.otherCommissionCents ?? 0}
                    sign="+"
                  />
                ) : null}
                <MoneyRow label="Expenses logged" count={w?.expensesCount} amount={w?.expensesCents ?? 0} sign="−" tone="down" />
                <MoneyRow label="Net in period" amount={netInPeriod} strong tone={netInPeriod < 0 ? 'down' : undefined} rule />

                {/* Memo lines: real money, but NOT terms of "Net in period" — adding them would
                    double-count (an approved advance is already one of the expenses above) or mix a
                    payout, which the lifetime ladder below is what nets. */}
                {/* No `count` on the advance rows: `advancesCount` counts every request raised in
                    the window whatever its status, so hanging it off the "approved" amount would
                    read as a count of approvals. The Activity ▸ Advances tab carries that badge. */}
                <MemoHeading>For the record · {w?.advancesCount ?? 0} advance request{(w?.advancesCount ?? 0) === 1 ? '' : 's'}</MemoHeading>
                <MoneyRow label="Advances approved" amount={w?.advancesApprovedCents ?? 0}
                  hint="Counted once already, inside Expenses logged." muted />
                <MoneyRow label="Advances pending" amount={w?.advancesPendingCents ?? 0} muted />
                <MoneyRow label="Payouts paid to you" amount={w?.payoutsPaidCents ?? 0} muted />
                <MoneyRow label="Payouts awaiting approval" amount={w?.payoutsPendingCents ?? 0} muted />
              </>
            )}
          </tbody>
        </table>
        <p className="px-3 pb-2 pt-1 text-[11px] leading-snug text-muted">
          Period figures only. They do not add up to your withdrawable balance — the table below does.
        </p>

        {/* The lines behind the period figures. A disclosure, so the summary stays the first thing
            read. Deliberately NOT a source of any total: this is a page of at most `limit` rows. */}
        {lines.length > 0 ? (
          <details className="border-t border-border">
            <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-muted hover:text-fg">
              Show the {lines.length} line{lines.length === 1 ? '' : 's'} in this period
            </summary>
            <table className="w-full table-fixed border-collapse text-left">
              <caption className="px-3 pb-1 text-left text-[10px] leading-snug text-muted">
                Newest first, up to {money.data?.limit ?? 50} rows. A row is not a total — the figures above are.
              </caption>
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted">
                  <th scope="col" className="w-[24%] px-3 py-1 font-medium">Date</th>
                  <th scope="col" className="w-[44%] px-1 py-1 font-medium">What</th>
                  <th scope="col" className="w-[32%] px-3 py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-border/60">
                    <td className="min-w-0 px-3 py-1.5 align-top text-[11px] tabular-nums text-muted">
                      <span className="block truncate">{new Date(l.atMs).toLocaleDateString('en-KE', { day: '2-digit', month: 'short' })}</span>
                    </td>
                    <th scope="row" className="min-w-0 px-1 py-1.5 text-left align-top font-normal">
                      <span className="block truncate text-xs text-fg" title={l.what}>{l.what}</span>
                    </th>
                    <td className="px-3 py-1.5 align-top">
                      <FitText className={`text-right text-xs font-medium tabular-nums ${l.tone === 'up' ? 'text-up' : l.tone === 'down' ? 'text-down' : 'text-muted'}`}>
                        {l.amount}
                      </FitText>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>

      {/* ── LIFETIME (the trust anchor; no filter touches it) ─────────────────────────────────── */}
      <div className="min-w-0 rounded-2xl border border-border bg-surface-2">
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">Balance</h3>
          <ScopePill>Lifetime · not filtered</ScopePill>
        </div>
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="px-3 pt-2 text-left text-[11px] text-muted">
            Every commission and expense ever recorded, ending on the figure at the top of this page.
          </caption>
          <tbody>
            <MoneyRow label="Earned" amount={lifetime.earnedCents} />
            <MoneyRow label="Expenses" amount={lifetime.expensesCents} sign="−" tone="down" />
            <MoneyRow label="Net after expenses" amount={netAfterExpenses} strong
              tone={netAfterExpenses < 0 ? 'down' : undefined} rule />
            {lifetime.paidCents > 0 ? <MoneyRow label="Paid out" amount={lifetime.paidCents} sign="−" tone="down" /> : null}
            {lifetime.heldCents > 0 ? <MoneyRow label="Pending payout" amount={lifetime.heldCents} sign="−" tone="down" /> : null}
            <MoneyRow label="Available to withdraw" amount={lifetime.availableCents} strong tone="up" rule />
          </tbody>
        </table>
        <p className="px-3 pb-2.5 pt-1 text-[11px] leading-snug text-muted">
          {netPosition < 0 ? (
            <>Received {formatKes(lifetime.paidCents + lifetime.heldCents)} of {formatKes(netAfterExpenses)} net. Upcoming commission clears the balance. </>
          ) : null}
          {range === 'all'
            ? 'Showing All time above, so Earned and Expenses there match the first two lines here.'
            : `“${label}” above filters the period table only — this balance is always all-time.`}
        </p>
      </div>
    </section>
  );
}

/** Which scope a table covers. Short on purpose: it sits next to a heading at 320px. */
function ScopePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
      {children}
    </span>
  );
}

/**
 * One money line.
 *
 * The label truncates; the amount never does (`FitText` shrinks it just enough and shows it in
 * full). `table-fixed` gives both cells their width from the layout, which is the condition FitText
 * documents for itself.
 */
function MoneyRow({ label, hint, count, amount, sign, tone, strong, rule, muted }: {
  label: string;
  hint?: string;
  count?: number | undefined;
  amount: number;
  sign?: '+' | '−';
  tone?: 'up' | 'down' | undefined;
  strong?: boolean;
  rule?: boolean;
  muted?: boolean;
}) {
  const toneCls = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg';
  // A zero line carries no sign: "−KES 0" reads as a deduction that did not happen. A negative
  // amount always shows the minus, whatever `sign` says.
  const prefix = amount < 0 ? '−' : amount !== 0 && sign ? sign : '';
  const signed = `${prefix}${formatKes(Math.abs(amount))}`;
  return (
    <tr className={rule ? 'border-t border-border' : undefined}>
      <th scope="row" className="min-w-0 px-3 py-1.5 text-left font-normal align-top">
        <span className={`block truncate text-xs ${strong ? 'font-semibold text-fg' : 'text-muted'}`} title={hint ?? label}>
          {label}
        </span>
        {hint ? <span className="block text-[10px] leading-tight text-muted/80">{hint}</span> : null}
      </th>
      <td className="px-1 py-1.5 text-right align-top text-[11px] tabular-nums text-muted">
        {typeof count === 'number' ? count : ''}
      </td>
      <td className="px-3 py-1.5 align-top">
        <FitText className={`text-right tabular-nums ${strong ? 'text-sm font-bold' : 'text-sm font-medium'} ${muted ? 'text-muted' : toneCls}`}>
          {signed}
        </FitText>
      </td>
    </tr>
  );
}

function MemoHeading({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <th scope="rowgroup" colSpan={3} className="px-3 pb-0.5 pt-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted/80">
        {children}
      </th>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <tr key={i}>
          <td colSpan={3} className="px-3 py-1.5"><div className="h-4 animate-pulse rounded bg-surface" /></td>
        </tr>
      ))}
    </>
  );
}
