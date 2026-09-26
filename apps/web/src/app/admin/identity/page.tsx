'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatAgo } from '@/lib/format';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { PageHeader, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { PageTabs, useTabParam } from '@/components/admin/Tabs';
import { useKycList, useKycDetail, useKycDecision, fileUrl, DOC_LABEL, type KycStaffRow } from '@/lib/account/accountUi';

const TABS = [
  { id: 'pending', label: 'To review', hint: 'Oldest first. Check the name, number and date of birth against the document, and the selfie against its photo.' },
  { id: 'approved', label: 'Approved', hint: 'Players whose identity you confirmed.' },
  { id: 'rejected', label: 'Not approved', hint: 'Players asked to send new documents. They see your note.' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** ACCT-1: identity checks for this brand — review each submission and approve or reject with a note. */
export default function IdentityChecksPage() {
  const [tab, setTab] = useTabParam<Tab>(TABS.map((t) => t.id), 'pending');
  const list = useKycList(tab);
  const [open, setOpen] = useState<string | null>(null);
  // deep link from a player's page: /admin/identity?open=<submission id>
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('open');
    if (v && /^[0-9a-f-]{36}$/i.test(v)) setOpen(v);
  }, []);
  const rows = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Identity checks" />
      <PageTabs tabs={[...TABS]} value={tab} onChange={setTab} label="Identity checks" />
      <p className="text-sm text-muted">{TABS.find((t) => t.id === tab)?.hint}</p>
      {list.isLoading ? <p className="text-sm text-muted">Loading…</p> : rows.length === 0 ? (
        <Empty title={tab === 'pending' ? 'Nothing to review' : 'Nothing here yet'} description={tab === 'pending' ? 'New submissions appear here.' : ''} />
      ) : (
        <TableWrap>
          <thead><tr className="border-b border-border"><Th>Player</Th><Th>Document</Th><Th>Name on document</Th><Th>Sent</Th>{tab !== 'pending' ? <Th>Reviewed</Th> : null}<Th className="text-right"> </Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <Td><Link href={`/admin/users/${r.userId}`} className="font-medium text-accent hover:underline">@{r.username ?? 'player'}</Link><div className="text-[11px] text-muted">{r.phone}</div></Td>
                <Td>{DOC_LABEL[r.docType]}</Td>
                <Td>{r.fullName}</Td>
                <Td className="text-xs text-muted">{formatAgo(Date.parse(r.submittedAt))}</Td>
                {tab !== 'pending' ? <Td className="text-xs text-muted">{r.reviewedAt ? formatAgo(Date.parse(r.reviewedAt)) : '—'}{r.reviewerName ? ` by @${r.reviewerName}` : ''}</Td> : null}
                <Td className="text-right"><button type="button" onClick={() => setOpen(r.id)} className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold text-fg hover:border-accent/50">{tab === 'pending' ? 'Review' : 'View'}</button></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {open ? <ReviewDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ReviewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useKycDetail(id);
  const decide = useKycDecision();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const s = q.data?.submission;
  const act = (decision: 'approved' | 'rejected') => decide.mutate({ id, decision, ...(note.trim() ? { note: note.trim() } : {}) }, {
    onSuccess: () => { toast.push({ tone: 'success', title: decision === 'approved' ? 'Identity approved' : 'Sent back to the player' }); onClose(); },
    onError: (e) => toast.push({ tone: 'error', title: 'Not saved', description: e instanceof ApiError ? e.message : 'Try again.' }),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3" role="dialog" aria-modal="true" aria-label="Review identity">
      <button aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-fg">{s ? `@${s.username ?? 'player'} · ${DOC_LABEL[s.docType]}` : 'Review identity'}</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-fg" aria-label="Close">✕</button>
        </header>
        {!s ? <p className="p-5 text-sm text-muted">{q.isError ? 'Could not load this submission.' : 'Loading…'}</p> : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 md:grid-cols-[1fr_260px]">
            <div className="grid grid-cols-2 gap-3">
              {([['Front', s.files?.front], ['Back', s.files?.back], ['Selfie', s.files?.selfie]] as const).map(([label, url]) => url ? (
                <figure key={label} className="flex flex-col gap-1">
                  <figcaption className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</figcaption>
                  <Doc url={fileUrl(url)!} onZoom={setZoom} />
                </figure>
              ) : null)}
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <Row k="Full name" v={s.fullName} /><Row k="Document number" v={s.idNumber} /><Row k="Date of birth" v={s.dateOfBirth} />
              <Row k="Phone" v={s.phone ?? '—'} /><Row k="Status" v={s.status} />
              {s.reviewNote ? <Row k="Note" v={s.reviewNote} /> : null}
              {s.status === 'pending' ? (
                <>
                  <label className="mt-2 flex flex-col gap-1 text-xs text-muted">Note to the player (required to reject)
                    <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={3} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent" placeholder="e.g. The photo is blurry — please send a clearer one." />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={decide.isPending || !note.trim()} onClick={() => act('rejected')} className="rounded-lg border border-down/50 py-2 text-[13px] font-semibold text-down disabled:opacity-40">Reject</button>
                    <button type="button" disabled={decide.isPending} onClick={() => act('approved')} className="rounded-lg bg-up py-2 text-[13px] font-bold text-white disabled:opacity-40">Approve</button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {zoom ? <div className="fixed inset-0 z-[60] grid place-items-center bg-black/90 p-4" onClick={() => setZoom(null)}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={zoom} alt="Document" className="max-h-full max-w-full" /></div> : null}
    </div>
  );
}
function Doc({ url, onZoom }: { url: string; onZoom: (u: string) => void }) {
  const [pdf, setPdf] = useState(false);
  return pdf
    ? <a href={url} target="_blank" rel="noopener noreferrer" className="grid h-40 place-items-center rounded-lg border border-border text-sm text-accent underline">Open PDF</a>
    // eslint-disable-next-line @next/next/no-img-element
    : <img src={url} alt="" onError={() => setPdf(true)} onClick={() => onZoom(url)} className={cn('h-40 w-full cursor-zoom-in rounded-lg border border-border object-cover')} />;
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex flex-col"><span className="text-[11px] text-muted">{k}</span><span className="font-medium text-fg">{v}</span></div>;
}
export type { KycStaffRow };
