'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { useRegistrarDomains } from '@/lib/platform/hooks';
import { platformApi, type RegistrarDomainRow } from '@/lib/platform/endpoints';

type RowState = { status: 'idle' | 'queued' | 'working' | 'done' | 'error'; message?: string };

/**
 * Import clients from the registrar (Namecheap): fetch the account's domains, exclude those already
 * used as clients, multi-select any subset (tested to hundreds), and onboard them in one bulk run with
 * live per-row progress. Each domain reuses the proven POST /platform/onboard path (brand + economy +
 * Cloudflare zone/DNS/Pages/SSL + registrar nameservers), so results are consistent and idempotent.
 */
export function DomainImport({ platformId }: { platformId?: string | undefined } = {}) {
  // docs/42 UI-9: the System admin imports from the CHOSEN platform's registrar into that platform
  // (was: always the default platform's registrar, brands created without a platform).
  const { data, isLoading, isError, error, refetch, isFetching } = useRegistrarDomains(true, platformId);
  const token = useSession((s) => s.token) as string;
  const qc = useQueryClient();

  const [query, setQuery] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);
  const [provision, setProvision] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [slugs, setSlugs] = useState<Record<string, string>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);

  const all = data?.domains ?? [];
  const availableCount = all.filter((d) => !d.alreadyClient).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((d) => (!availableOnly || !d.alreadyClient) && (!q || d.domain.includes(q)));
  }, [all, query, availableOnly]);

  const selectableRows = rows.filter((d) => !d.alreadyClient);
  const allSelected = selectableRows.length > 0 && selectableRows.every((d) => selected.has(d.domain));

  const slugOf = (d: RegistrarDomainRow) => slugs[d.domain] ?? d.suggestedSlug;
  const toggle = (dom: string) => setSelected((s) => { const n = new Set(s); n.has(dom) ? n.delete(dom) : n.add(dom); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allSelected) selectableRows.forEach((d) => n.delete(d.domain));
    else selectableRows.forEach((d) => n.add(d.domain));
    return n;
  });

  async function runOnboard() {
    const targets = all.filter((d) => selected.has(d.domain) && !d.alreadyClient);
    if (!targets.length) return;
    setRunning(true);
    setRowState((s) => { const n = { ...s }; targets.forEach((d) => (n[d.domain] = { status: 'queued' })); return n; });
    const setState = (dom: string, st: RowState) => setRowState((s) => ({ ...s, [dom]: st }));
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const d = targets[i++]!;
        setState(d.domain, { status: 'working' });
        try {
          const r = await platformApi.onboard(token, {
            slug: slugOf(d), name: d.suggestedName, primaryDomain: d.domain, provisionDomain: provision,
            ...(platformId ? { platformId } : {}),
          });
          const dm = r.domain;
          const msg = !dm ? 'Brand created' : dm.nameserversUpdated ? 'Live — nameservers set' : `Set NS: ${dm.nameServers.join(', ')}`;
          setState(d.domain, { status: 'done', message: msg });
        } catch (e) {
          setState(d.domain, { status: 'error', message: (e as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    setRunning(false);
    void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
    void qc.invalidateQueries({ queryKey: ['platform', 'overview'] });
    void qc.invalidateQueries({ queryKey: ['platform', 'registrar-domains'] });
  }

  const doneCount = Object.values(rowState).filter((r) => r.status === 'done').length;
  const errCount = Object.values(rowState).filter((r) => r.status === 'error').length;
  const selectedCount = [...selected].filter((dom) => !all.find((d) => d.domain === dom)?.alreadyClient).length;

  if (isLoading) return <p className="text-sm text-muted">Loading domains from Namecheap…</p>;
  if (isError) return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <p className="text-fg">Couldn’t reach the registrar: <span className="text-amber-500">{(error as Error).message}</span></p>
      <p className="mt-1 text-xs text-muted">If this says an IP isn’t whitelisted, add the API server’s egress IP in Namecheap → API Access → Whitelisted IPs, then Refresh.</p>
      <button onClick={() => refetch()} className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-2">Retry</button>
    </div>
  );
  if (data && !data.registrarConfigured) return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-fg">
      Registrar import isn’t configured on this deployment (Namecheap secrets missing). Add them to enable importing domains.
    </div>
  );

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5">
      {/* Header + toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">Import from Namecheap</h2>
          <p className="mt-0.5 text-xs text-muted">{availableCount} available · {all.length - availableCount} already clients · {all.length} total</p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-50">
          {isFetching ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search domains…"
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} /> Available only</label>
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={provision} onChange={(e) => setProvision(e.target.checked)} /> Auto-provision (Cloudflare + nameservers)</label>
      </div>

      {/* Table */}
      <div className="max-h-[56vh] overflow-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="w-10 px-3 py-2"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all available" /></th>
              <th className="px-3 py-2">Domain</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Brand slug</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const rs = rowState[d.domain];
              const isSel = selected.has(d.domain);
              return (
                <tr key={d.domain} className="border-b border-border/60 last:border-0 hover:bg-surface/60">
                  <td className="px-3 py-2">
                    <input type="checkbox" disabled={d.alreadyClient} checked={isSel} onChange={() => toggle(d.domain)} aria-label={`Select ${d.domain}`} />
                  </td>
                  <td className="px-3 py-2 font-medium text-fg">{d.domain}</td>
                  <td className="px-3 py-2">
                    {d.alreadyClient
                      ? <span className="rounded-full border border-border bg-border/30 px-2 py-0.5 text-[11px] text-muted">Already a client</span>
                      : <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">Available</span>}
                  </td>
                  <td className="px-3 py-2">
                    {d.alreadyClient ? <span className="text-xs text-muted">—</span> : (
                      <input value={slugOf(d)} onChange={(e) => setSlugs((s) => ({ ...s, [d.domain]: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                        className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent" />
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{d.expires ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {!rs ? <span className="text-muted">—</span>
                      : rs.status === 'working' ? <span className="text-accent">Working…</span>
                      : rs.status === 'queued' ? <span className="text-muted">Queued</span>
                      : rs.status === 'done' ? <span className="text-emerald-500">✓ {rs.message}</span>
                      : <span className="text-red-500">✕ {rs.message}</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted">No domains match.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {/* Sticky action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">
        <div className="text-xs text-muted">
          <span className="font-semibold text-fg">{selectedCount}</span> selected
          {(doneCount || errCount) ? <> · <span className="text-emerald-500">{doneCount} done</span>{errCount ? <> · <span className="text-red-500">{errCount} failed</span></> : null}</> : null}
        </div>
        <button type="button" onClick={runOnboard} disabled={running || selectedCount === 0}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:opacity-90 disabled:opacity-50">
          {running ? `Onboarding… (${doneCount + errCount}/${selectedCount})` : `Onboard ${selectedCount} selected`}
        </button>
      </div>
      {provision ? <p className="text-[11px] text-muted">Auto-provision moves each domain’s nameservers to Cloudflare (if the registrar API is authorised) and attaches it to the Pages project; SSL issues once the zone activates.</p> : null}
    </div>
  );
}
