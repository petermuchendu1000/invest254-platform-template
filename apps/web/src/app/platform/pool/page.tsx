'use client';

import { useMemo, useState } from 'react';
import { PageHeader, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  usePlatformSites, useDistributePool, usePoolDistributions, usePoolDemand, useDistributePoolDynamic,
} from '@/lib/platform/hooks';

/**
 * Withdrawal-pool console for PLATFORM ADMINS (Issue 1 #4). Every action is scoped server-side to the
 * caller's platform (the API derives the platform from the token; the RPC refuses cross-platform writes).
 * Set each brand's daily payout budget — wins are hard-capped at the pool per day.
 */
const money = (cents: number, cur = 'KES') => `${cur} ${(cents / 100).toLocaleString()}`;
const toCents = (kes: string): number => Math.round(Number(kes) * 100);

export default function PlatformPoolPage() {
  const sitesQ = usePlatformSites();
  const distMut = useDistributePool();
  const dynMut = useDistributePoolDynamic();
  const distsQ = usePoolDistributions();

  const sites = useMemo(() => (sitesQ.data?.sites ?? []).filter((s) => s.status === 'active'), [sitesQ.data]);

  const [mode, setMode] = useState<'equal' | 'per_site'>('equal');
  const [totalKes, setTotalKes] = useState('');
  const [perBrand, setPerBrand] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  // Demand-based suggestion (read-only preview until applied).
  const [lookback, setLookback] = useState('14');
  const [demandKes, setDemandKes] = useState('');
  const [previewOn, setPreviewOn] = useState(false);
  const demandQ = usePoolDemand(
    { lookbackDays: Number(lookback) || 14, ...(demandKes ? { totalCents: toCents(demandKes) } : {}) },
    previewOn,
  );
  const preview = demandQ.data?.preview;

  const submitDistribute = () => {
    setMsg(null);
    if (mode === 'equal') {
      const c = toCents(totalKes);
      if (!Number.isInteger(c) || c < 0) { setMsg('Enter a valid total amount.'); return; }
      distMut.mutate({ totalCents: c, mode: 'equal' }, { onSuccess: () => setMsg('Daily pool distributed across your active brands.') });
    } else {
      const overrides: Record<string, number> = {};
      for (const s of sites) { const v = perBrand[s.siteId]; if (v != null && v !== '') overrides[s.siteId] = toCents(v); }
      if (Object.keys(overrides).length === 0) { setMsg('Enter at least one brand amount.'); return; }
      distMut.mutate({ mode: 'per_site', overrides }, { onSuccess: () => setMsg('Per-brand daily pools saved.') });
    }
  };

  return (
    <>
      <PageHeader
        title="Withdrawal pool"
        subtitle="Set each of your brands' daily payout budget. Total daily winnings are hard-capped at the pool, protecting your cash flow."
      />

      {sites.length === 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-fg">
          You have no active brands yet. Onboard a client first, then set its daily pool here.
        </div>
      ) : null}

      {/* ── Distribute ─────────────────────────────────────────────────────────────────────── */}
      <Section title="Set the daily pool">
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={mode === 'equal' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('equal')}>Equal split</Button>
            <Button type="button" variant={mode === 'per_site' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('per_site')}>Per brand</Button>
          </div>

          {mode === 'equal' ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56"><Input label="Total daily pool (KES)" inputMode="decimal" value={totalKes} onChange={(e) => setTotalKes(e.target.value)} placeholder="e.g. 500000" /></div>
              <span className="text-sm text-muted">Split equally across your {sites.length} active brand{sites.length === 1 ? '' : 's'}.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {sites.map((s) => (
                <div key={s.siteId} className="flex flex-wrap items-center gap-3">
                  <span className="w-40 truncate text-sm font-medium text-fg">{s.name}</span>
                  <div className="w-48">
                    <Input label="" inputMode="decimal" value={perBrand[s.siteId] ?? ''} onChange={(e) => setPerBrand((p) => ({ ...p, [s.siteId]: e.target.value }))} placeholder="daily pool (KES)" />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={distMut.isPending || sites.length === 0} onClick={submitDistribute}>
              {distMut.isPending ? 'Saving…' : mode === 'equal' ? 'Distribute equally' : 'Save per-brand pools'}
            </Button>
            {msg ? <span className="text-sm text-up">{msg}</span> : null}
            {distMut.isError ? <span className="text-sm text-down">{(distMut.error as Error).message}</span> : null}
          </div>
        </div>
      </Section>

      {/* ── Demand-based suggestion ────────────────────────────────────────────────────────── */}
      <Section title="Dynamic pool distribution (demand-based)">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
          <p className="text-sm text-muted">Forecasts each brand&rsquo;s recent player turnover over the lookback window and allocates the pool where demand is highest (water-fill). Preview first, then apply &mdash; it sets each brand&rsquo;s daily pool for you.</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40"><Input label="Lookback (days)" inputMode="numeric" value={lookback} onChange={(e) => setLookback(e.target.value)} /></div>
            <div className="w-56"><Input label="Total to allocate (KES)" inputMode="decimal" value={demandKes} onChange={(e) => setDemandKes(e.target.value)} placeholder="blank = keep current total" optional /></div>
            <Button type="button" variant="secondary" onClick={() => setPreviewOn(true)} disabled={demandQ.isFetching}>{demandQ.isFetching ? 'Forecasting…' : 'Preview'}</Button>
          </div>

          {previewOn && preview ? (
            <>
              <TableWrap>
                <table className="w-full text-sm">
                  <thead><tr><Th>Brand</Th><Th>Forecast turnover</Th><Th>Required</Th><Th>Current</Th><Th>Suggested</Th><Th>Coverage</Th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.siteId}>
                        <Td>{r.slug}</Td><Td>{money(r.forecastTurnoverCents)}</Td><Td>{money(r.requiredCents)}</Td>
                        <Td>{money(r.currentPoolCents)}</Td><Td>{money(r.suggestedCents)}</Td>
                        <Td>{Math.round((r.coverage ?? 0) * 100)}%</Td>
                      </tr>
                    ))}
                    {preview.rows.length === 0 ? <tr><Td>No pool-mode brands with recent activity.</Td><Td> </Td><Td> </Td><Td> </Td><Td> </Td><Td> </Td></tr> : null}
                  </tbody>
                </table>
              </TableWrap>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted">Suggested total: <b className="text-fg">{money(preview.suggestedTotalCents)}</b> &middot; Reserve (unallocated): <b className="text-fg">{money(preview.reserveCents)}</b></span>
                <Button
                  type="button" disabled={dynMut.isPending || preview.rows.length === 0}
                  onClick={() => { setMsg(null); dynMut.mutate({ lookbackDays: Number(lookback) || 14, ...(demandKes ? { totalCents: toCents(demandKes) } : {}) }, { onSuccess: () => setMsg('Applied the demand-based allocation to your brands.') }); }}
                >
                  {dynMut.isPending ? 'Applying…' : 'Apply suggestion'}
                </Button>
                {dynMut.isError ? <span className="text-sm text-down">{(dynMut.error as Error).message}</span> : null}
              </div>
            </>
          ) : previewOn && demandQ.isError ? (
            <span className="text-sm text-down">{(demandQ.error as Error).message}</span>
          ) : null}
        </div>
      </Section>

      {/* ── History ───────────────────────────────────────────────────────────────────────── */}
      <Section title="Recent distributions">
        <TableWrap>
          <table className="w-full text-sm">
            <thead><tr><Th>When</Th><Th>Mode</Th><Th>Brands</Th><Th>Total</Th></tr></thead>
            <tbody>
              {(distsQ.data?.distributions ?? []).map((d) => (
                <tr key={d.id}>
                  <Td>{new Date(d.createdAt).toLocaleString()}</Td><Td>{d.mode}</Td><Td>{d.siteCount}</Td><Td>{money(d.totalCents)}</Td>
                </tr>
              ))}
              {(distsQ.data?.distributions ?? []).length === 0 ? <tr><Td>No distributions yet.</Td><Td> </Td><Td> </Td><Td> </Td></tr> : null}
            </tbody>
          </table>
        </TableWrap>
      </Section>
    </>
  );
}
