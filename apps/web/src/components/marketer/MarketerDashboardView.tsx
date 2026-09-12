'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatKes } from '@invest254/shared/money';
import { ApiError } from '@/lib/api/client';
import { pageInfo, pageSlice, type PageInfo } from '@/lib/affiliate/paginate';
import {
  useMarketerLiveSummary,
  useAffiliateReferrals,
  useAffiliateExpenses,
  useAffiliateEnroll,
  useReferral,
  useMyCommissions,
  useRequestCommissionPayout,
  useMyAdvances,
  useRequestAdvance,
  useCancelAdvance,
} from '@/lib/affiliate/hooks';

/**
 * Full-page marketer dashboard (rendered at /dashboard). Extracted from the old covert modal so
 * the marketer gets a real, shareable, back-button-friendly page instead of an overlay.
 *
 * Information architecture (bank-standard, progressive disclosure):
 *   1. The dominant, role-first metric — "Available to withdraw" — leads the page with its action.
 *   2. Performance KPIs and the reconciling commission statement summarise standing at a glance.
 *   3. Row-level history (earnings, expenses, referrals, advance requests) lives in ONE tabbed
 *      "Activity" ledger, paged a bounded number of rows at a time — never a 50-row data dump.
 * The statement is the trust anchor: every line flows into the next and lands on the exact figure
 * the hero shows as "Available to withdraw" (earned − expenses − paid − held, floored at 0).
 *
 * Self-heal: a user can hold role='marketer' yet have no `affiliates` row (e.g. an admin promoted
 * them via fn_admin_set_user_role rather than the enroll flow). That makes /affiliate/summary 404
 * with NOT_AFFILIATE. Enrollment is idempotent + marketer-safe, so on that exact error we enroll
 * once (creating the row + adopting the reissued token) and let the query refetch — the dashboard
 * then loads instead of dead-ending on "Couldn't load". The server root-cause fix (auto-enroll on
 * marketer promotion) makes this path rare; this stays as a resilient safety net.
 */

/** Rows shown per page in every Activity ledger tab. */
const LEDGER_PAGE_SIZE = 6;

type ActivityTab = 'earnings' | 'expenses' | 'referrals' | 'advances';

export function MarketerDashboardView() {
  const q = useMarketerLiveSummary(true);
  const referrals = useAffiliateReferrals(true);
  const commissions = useMyCommissions(true);       // deposit-based commission line items
  const expenses = useAffiliateExpenses(true);
  const payout = useRequestCommissionPayout();       // separate commission-payout stream
  const enroll = useAffiliateEnroll();
  const ref = useReferral(true);                     // deposit-commission balance + code/link
  const healAttempted = useRef(false);
  const [payoutMsg, setPayoutMsg] = useState<{ tone: 'up' | 'down'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const advances = useMyAdvances(true);                // marketer's advance requests (polled)
  const requestAdvance = useRequestAdvance();
  const cancelAdvance = useCancelAdvance();
  const [advAmount, setAdvAmount] = useState('');
  const [advReason, setAdvReason] = useState('');
  const [advMsg, setAdvMsg] = useState<{ tone: 'up' | 'down'; text: string } | null>(null);

  // Activity ledger: one active tab, one 1-based page. Switching tabs resets to the first page so
  // the marketer never lands on a now-out-of-range page (pageInfo would clamp anyway, but resetting
  // is the least surprising behaviour).
  const [tab, setTab] = useState<ActivityTab>('earnings');
  const [page, setPage] = useState(1);
  const selectTab = (next: ActivityTab) => { setTab(next); setPage(1); };

  const s = q.data;
  const isNotAffiliate = q.error instanceof ApiError && q.error.code === 'NOT_AFFILIATE';

  // Self-heal exactly once when the summary 404s because no affiliate row exists yet.
  useEffect(() => {
    if (healAttempted.current) return;
    if (isNotAffiliate && !enroll.isPending) {
      healAttempted.current = true;
      enroll.mutate(); // onSuccess invalidates ['affiliate'] -> summary refetches automatically.
    }
  }, [isNotAffiliate, enroll]);

  const healing = enroll.isPending || (isNotAffiliate && !enroll.isError && !s);

  const refRows = referrals.data?.pages.flatMap((p) => p.items) ?? [];
  const commRows = commissions.data?.items ?? [];
  const expRows = expenses.data?.items ?? [];
  const expTotal = expenses.data?.totalCents ?? 0;

  // Money comes from the deposit-commission model (/me/referral), NOT the legacy GGR summary.
  // Use marketerEarnedCents (accrued marketer commission) — the SAME base that funds held/paid/
  // available in fn_commission_balance — so every figure below reconciles to "Available" (BUGLOG #23).
  const availableCents = ref.data?.availableCents ?? 0;
  const earnedAllTime = ref.data?.marketerEarnedCents ?? 0;
  const paidOutCents = ref.data?.paidCents ?? 0;
  const heldCents = ref.data?.heldCents ?? 0;
  const minPayoutCents = ref.data?.minPayoutCents ?? 50000;
  // "Net after expenses" is a WATERFALL SUBTOTAL (lifetime earnings minus expenses), not the money a
  // marketer can still take. The withdrawable is netPosition floored at 0 (== availableCents), which
  // additionally subtracts commission already paid out and pending. Showing earned − expenses alone
  // overstated the position of any marketer who'd been paid, so we present the full reconciling ladder.
  const netAfterExpenses = earnedAllTime - expTotal;
  const netPosition = earnedAllTime - expTotal - paidOutCents - heldCents;

  const requestPayout = () => {
    setPayoutMsg(null);
    payout.mutate(undefined, {
      onSuccess: (r) => setPayoutMsg({ tone: 'up', text: `${formatKes(r.amountCents)} requested · pending approval.` }),
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : '';
        const text = code === 'BELOW_MIN'
          ? `Min ${formatKes(minPayoutCents)} to withdraw.`
          : code === 'PAYOUT_PENDING'
            ? 'Payout already pending.'
            : 'Could not request. Try again.';
        setPayoutMsg({ tone: 'down', text });
      },
    });
  };

  const advRows = advances.data?.items ?? [];
  const hasPendingAdvance = advRows.some((a) => a.status === 'requested');
  const submitAdvance = () => {
    setAdvMsg(null);
    const kes = Number(advAmount);
    const amountCents = Math.round(kes * 100);
    if (!Number.isFinite(kes) || amountCents <= 0) { setAdvMsg({ tone: 'down', text: 'Enter a valid amount in KES.' }); return; }
    requestAdvance.mutate(
      { amountCents, ...(advReason.trim() ? { reason: advReason.trim() } : {}) },
      {
        onSuccess: () => { setAdvAmount(''); setAdvReason(''); setAdvMsg({ tone: 'up', text: 'Requested · pending review.' }); setTab('advances'); setPage(1); },
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : '';
          setAdvMsg({ tone: 'down', text: code === 'ADVANCE_PENDING' ? 'Advance already pending.' : 'Could not submit. Try again.' });
        },
      },
    );
  };

  const referralCode = ref.data?.referralCode ?? s?.referralCode ?? '';
  const referralLink = typeof window !== 'undefined' && ref.data?.referralPath
    ? `${window.location.origin}${ref.data.referralPath}` : (ref.data?.referralPath ?? '');
  const copyLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const retry = () => {
    healAttempted.current = false;
    enroll.reset();
    void q.refetch();
  };

  // Count backing the active tab drives its pager. Referrals shows the authoritative platform total
  // (some rows may still be unfetched behind the cursor) so the badge never under-reports a team.
  const activeCount =
    tab === 'earnings' ? commRows.length
    : tab === 'expenses' ? expRows.length
    : tab === 'referrals' ? refRows.length
    : advRows.length;
  const info = pageInfo(activeCount, page, LEDGER_PAGE_SIZE);
  const referralsTotal = ref.data?.totalReferrals ?? s?.totalReferrals ?? refRows.length;

  return (
    <section className="flex w-full flex-col gap-5">
      {/* Header */}
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-up" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-fg">Marketer dashboard</h1>
            <p className="truncate text-[11px] text-muted">
              {referralCode ? <>Code <span className="font-mono text-fg">{referralCode}</span> · Marketer{s ? <> · <span className="capitalize">{s.status}</span></> : null}</> : 'Live'}
            </p>
          </div>
        </div>
        <Link href="/" className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-fg" aria-label="Back to app">
          ← Back
        </Link>
      </header>

      {q.isLoading && !s ? (
        <div className="h-64 animate-pulse rounded-2xl bg-surface-2" />
      ) : healing ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-up" />
          <p className="text-sm text-muted">Setting up your marketer dashboard…</p>
        </div>
      ) : !s ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted">Couldn&apos;t load your dashboard. Try again shortly.</p>
          <button onClick={retry} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-surface-2">
            Try again
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Share your link (link-first — easiest to share) */}
          {referralLink ? (
            <section className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={referralLink}>{referralLink}</span>
              <button onClick={copyLink} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-black transition hover:brightness-105">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </section>
          ) : null}

          {/* Hero: available to withdraw + payout request (deposit-commission balance) */}
          <section className="rounded-2xl border border-up/30 bg-gradient-to-br from-up/10 to-transparent p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Available to withdraw</p>
            <p className="mt-1 text-3xl font-black tabular-nums text-up">{formatKes(availableCents)}</p>
            <button
              onClick={requestPayout}
              disabled={payout.isPending || availableCents < minPayoutCents}
              className="mt-3 w-full rounded-xl bg-up py-2.5 text-sm font-bold text-black transition hover:brightness-105 disabled:opacity-50 sm:w-auto sm:px-8"
            >
              {payout.isPending ? 'Requesting…' : 'Request payout'}
            </button>
            {payoutMsg ? (
              <p className={`mt-2 text-xs ${payoutMsg.tone === 'up' ? 'text-up' : 'text-down'}`}>{payoutMsg.text}</p>
            ) : (
              <p className="mt-2 text-[11px] text-muted">M-Pesa · min {formatKes(minPayoutCents)}.</p>
            )}
          </section>

          {/* KPI grid */}
          <section>
            <SectionTitle>Performance</SectionTitle>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Kpi label="Available" value={formatKes(availableCents)} tone="up" />
              <Kpi label="Earned all-time" value={formatKes(earnedAllTime)} />
              <Kpi label="Paid out" value={formatKes(paidOutCents)} />
              <Kpi label="Total referrals" value={String(referralsTotal)} />
              <Kpi label="Active (7d)" value={String(s.activePlayers7d)} />
              <Kpi label="New today" value={String(s.referralsToday)} />
              <Kpi label="Active today" value={String(s.activePlayersToday)} />
              <Kpi label="Clicks" value={String(s.clicks)} />
            </div>
          </section>

          {/* Commission statement — the reconciling trust anchor (earned → −expenses → −paid → available) */}
          <section>
            <SectionTitle>Statement</SectionTitle>
            <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface-2 px-4 py-3">
              <StatementRow label="Earned" value={formatKes(earnedAllTime)} />
              <StatementRow label="Expenses" value={`\u2212${formatKes(expTotal)}`} tone="down" />
              <div className="my-0.5 border-t border-border" />
              <StatementRow label="Net" value={formatKes(netAfterExpenses)} strong tone={netAfterExpenses >= 0 ? undefined : 'down'} />
              {paidOutCents > 0 ? <StatementRow label="Paid out" value={`\u2212${formatKes(paidOutCents)}`} tone="down" /> : null}
              {heldCents > 0 ? <StatementRow label="Pending" value={`\u2212${formatKes(heldCents)}`} tone="down" /> : null}
              <div className="my-0.5 border-t border-border" />
              <StatementRow label="Available" value={formatKes(availableCents)} strong tone="up" />
            </div>
            {netPosition < 0 ? (
              <p className="mt-1.5 text-[11px] leading-snug text-muted">
                Received {formatKes(paidOutCents + heldCents)} of {formatKes(netAfterExpenses)} net. Upcoming commission clears the balance.
              </p>
            ) : null}
          </section>

          {/* Request an advance — the action lives with the money; its history is in Activity ▸ Advances */}
          <section>
            <SectionTitle>Advance</SectionTitle>
            <div className="rounded-2xl border border-border bg-surface-2 p-3">
              <p className="text-[11px] leading-snug text-muted">
                Cash against upcoming commission. Admin-reviewed, recovered from earnings.
              </p>
              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                <input
                  inputMode="decimal"
                  value={advAmount}
                  onChange={(e) => setAdvAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="Amount (KES)"
                  aria-label="Advance amount in KES"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm tabular-nums text-fg outline-none focus:border-accent sm:max-w-[10rem]"
                />
                <input
                  value={advReason}
                  onChange={(e) => setAdvReason(e.target.value)}
                  maxLength={200}
                  placeholder="Reason"
                  aria-label="Advance reason"
                  className="w-full flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
                <button
                  onClick={submitAdvance}
                  disabled={requestAdvance.isPending || hasPendingAdvance || !advAmount}
                  className="shrink-0 rounded-lg bg-accent py-2 text-sm font-bold text-black transition hover:brightness-105 disabled:opacity-50 sm:px-5"
                >
                  {hasPendingAdvance ? 'Pending review' : requestAdvance.isPending ? 'Requesting…' : 'Request advance'}
                </button>
              </div>
              {advMsg ? <p className={`mt-2 text-[11px] ${advMsg.tone === 'up' ? 'text-up' : 'text-down'}`}>{advMsg.text}</p> : null}
            </div>
          </section>

          {/* Activity — one tabbed, paged ledger replaces four unbounded lists (bank-standard). */}
          <section>
            <SectionTitle>Activity</SectionTitle>
            <div role="tablist" aria-label="Activity" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface-2 p-1">
              <TabButton active={tab === 'earnings'} onClick={() => selectTab('earnings')} label="Earnings" count={commRows.length} />
              <TabButton active={tab === 'expenses'} onClick={() => selectTab('expenses')} label="Expenses" count={expRows.length} />
              <TabButton active={tab === 'referrals'} onClick={() => selectTab('referrals')} label="Referrals" count={referralsTotal} />
              <TabButton active={tab === 'advances'} onClick={() => selectTab('advances')} label="Advances" count={advRows.length} />
            </div>

            <div className="mt-2.5" role="tabpanel">
              {/* EARNINGS */}
              {tab === 'earnings' ? (
                commissions.isLoading && commRows.length === 0 ? (
                  <LedgerSkeleton />
                ) : commRows.length === 0 ? (
                  <EmptyRow>No earnings yet.</EmptyRow>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1.5">
                      {pageSlice(commRows, page, LEDGER_PAGE_SIZE).map((c) => (
                        <li key={c.id} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
                          <span className="flex min-w-0 flex-col leading-tight">
                            <span className="truncate text-sm font-medium text-fg">{c.referredUsername ?? 'Referred deposit'}</span>
                            <span className="truncate text-[11px] text-muted">{Math.round(c.rate * 100)}% of {formatKes(c.depositAmountCents)} deposit · {new Date(c.createdAtMs).toLocaleDateString('en-KE')}</span>
                          </span>
                          <span className="shrink-0 text-sm font-semibold tabular-nums text-up">+{formatKes(c.commissionCents)}</span>
                        </li>
                      ))}
                    </ul>
                    <Pager info={info} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
                  </>
                )
              ) : null}

              {/* EXPENSES & ADVANCES (recovered) */}
              {tab === 'expenses' ? (
                expenses.isLoading && expRows.length === 0 ? (
                  <LedgerSkeleton />
                ) : expRows.length === 0 ? (
                  <EmptyRow>No expenses.</EmptyRow>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1.5">
                      {pageSlice(expRows, page, LEDGER_PAGE_SIZE).map((e) => {
                        const m = catMeta(e.category);
                        return (
                          <li key={e.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2">
                            <span className="text-lg leading-none">{m.glyph}</span>
                            <span className="flex min-w-0 flex-1 flex-col leading-tight">
                              <span className="truncate text-sm font-medium text-fg">{m.label}</span>
                              <span className="truncate text-[11px] text-muted">{e.note ?? '—'} · {new Date(e.createdAtMs).toLocaleDateString('en-KE')}</span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold tabular-nums text-down">−{formatKes(e.amountCents)}</span>
                          </li>
                        );
                      })}
                    </ul>
                    <Pager info={info} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
                  </>
                )
              ) : null}

              {/* REFERRALS (cursor-paged pool + client windowing) */}
              {tab === 'referrals' ? (
                referrals.isLoading && refRows.length === 0 ? (
                  <LedgerSkeleton />
                ) : refRows.length === 0 ? (
                  <EmptyRow>No referrals yet.</EmptyRow>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1.5">
                      {pageSlice(refRows, page, LEDGER_PAGE_SIZE).map((r, i) => (
                        <li key={`${r.username}-${info.start + i}`} className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
                              {(r.username || '?').slice(0, 2).toUpperCase()}
                            </span>
                            <span className="flex min-w-0 flex-col leading-tight">
                              <span className="truncate text-sm font-medium text-fg">@{r.username}</span>
                              <span className="text-[11px] text-muted">Joined {new Date(r.joinedAtMs).toLocaleDateString('en-KE')}</span>
                            </span>
                          </span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${r.lifetimeGgrCents > 0 ? 'bg-up/15 text-up' : 'bg-surface-2 text-muted'}`}>
                            {r.lifetimeGgrCents > 0 ? 'Active' : 'New'}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Pager info={info} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
                    {referrals.hasNextPage ? (
                      <button
                        onClick={() => referrals.fetchNextPage()}
                        disabled={referrals.isFetchingNextPage}
                        className="mt-2 w-full rounded-lg border border-border py-2 text-xs font-medium text-fg transition hover:bg-surface-2 disabled:opacity-50"
                      >
                        {referrals.isFetchingNextPage ? 'Loading…' : `Load more (${refRows.length}/${referralsTotal})`}
                      </button>
                    ) : null}
                  </>
                )
              ) : null}

              {/* ADVANCE REQUESTS */}
              {tab === 'advances' ? (
                advances.isLoading && advRows.length === 0 ? (
                  <LedgerSkeleton />
                ) : advRows.length === 0 ? (
                  <EmptyRow>No advances yet.</EmptyRow>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1.5">
                      {pageSlice(advRows, page, LEDGER_PAGE_SIZE).map((a) => (
                        <li key={a.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2">
                          <span className="flex min-w-0 flex-1 flex-col leading-tight">
                            <span className="truncate text-sm font-medium tabular-nums text-fg">{formatKes(a.amountCents)}</span>
                            <span className="truncate text-[11px] text-muted">
                              {a.reason ?? '—'} · {new Date(a.createdAtMs).toLocaleDateString('en-KE')}
                              {a.decisionNote ? ` · ${a.decisionNote}` : ''}
                            </span>
                          </span>
                          <AdvanceBadge status={a.status} />
                          {a.status === 'requested' ? (
                            <button
                              onClick={() => cancelAdvance.mutate(a.id)}
                              disabled={cancelAdvance.isPending}
                              className="shrink-0 text-[11px] text-muted underline underline-offset-2 hover:text-fg disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <Pager info={info} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
                  </>
                )
              ) : null}
            </div>
          </section>

          <p className="pb-1 text-center text-[11px] text-muted">Live · 5s</p>
        </div>
      )}
    </section>
  );
}

// ── Category presentation ────────────────────────────────────────────────────────────────────────
const CATEGORY_META: Record<string, { label: string; glyph: string }> = {
  tiktok_promo: { label: 'TikTok promo', glyph: '🎵' },
  data_bundles: { label: 'Data bundles', glyph: '📶' },
  advance: { label: 'Advance payment', glyph: '💵' },
  airtime: { label: 'Airtime', glyph: '📱' },
  transport: { label: 'Transport', glyph: '🚕' },
  other: { label: 'Other', glyph: '🧾' },
};
function catMeta(c: string) {
  return CATEGORY_META[c] ?? { label: c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), glyph: '🧾' };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'up' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-surface-2 p-3">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-base font-bold tabular-nums ${tone === 'up' ? 'text-up' : 'text-fg'}`}>{value}</span>
    </div>
  );
}

/** A single tab in the Activity ledger, with a live count badge. */
function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${active ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg'}`}
    >
      {label}
      {typeof count === 'number' ? (
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${active ? 'bg-black/15 text-accent-fg' : 'bg-surface text-muted'}`}>{count}</span>
      ) : null}
    </button>
  );
}

/** "Showing X–Y of N" with prev/next controls. Hidden entirely when a single (or empty) page. */
function Pager({ info, onPrev, onNext }: { info: PageInfo; onPrev: () => void; onNext: () => void }) {
  if (info.total === 0 || info.pageCount <= 1) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted">
      <span className="tabular-nums">{info.start + 1}-{info.end} of {info.total}</span>
      <div className="flex items-center gap-1">
        <button onClick={onPrev} disabled={!info.hasPrev} className="rounded-lg border border-border px-2.5 py-1 font-medium text-fg transition hover:bg-surface-2 disabled:opacity-40" aria-label="Previous page">Prev</button>
        <span className="px-1 tabular-nums">{info.page}/{info.pageCount}</span>
        <button onClick={onNext} disabled={!info.hasNext} className="rounded-lg border border-border px-2.5 py-1 font-medium text-fg transition hover:bg-surface-2 disabled:opacity-40" aria-label="Next page">Next</button>
      </div>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-border bg-surface-2 px-3 py-3 text-center text-xs text-muted">{children}</p>;
}

function LedgerSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
      <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
      <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

/** Coloured status pill for an advance request. */
function AdvanceBadge({ status }: { status: 'requested' | 'approved' | 'rejected' | 'cancelled' }) {
  const map = {
    requested: { label: 'Pending', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-500' },
    approved: { label: 'Approved', cls: 'border-up/40 bg-up/10 text-up' },
    rejected: { label: 'Declined', cls: 'border-down/40 bg-down/10 text-down' },
    cancelled: { label: 'Cancelled', cls: 'border-border bg-surface-2 text-muted' },
  } as const;
  const m = map[status] ?? map.cancelled;
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${m.cls}`}>{m.label}</span>;
}

/** One line of the marketer's reconciling commission statement (earned → −expenses → −paid → available). */
function StatementRow({ label, value, tone, strong }: { label: string; value: string; tone?: 'up' | 'down' | undefined; strong?: boolean }) {
  const valueTone = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-xs ${strong ? 'font-semibold text-fg' : 'text-muted'}`}>{label}</span>
      <span className={`tabular-nums ${strong ? 'text-sm font-bold' : 'text-sm font-medium'} ${valueTone}`}>{value}</span>
    </div>
  );
}
