'use client';

/**
 * Shared internal-ticketing view (Issue 2). Used by both the site-admin back office (/admin/tickets)
 * and the platform/system console (/platform/tickets) — the API scopes results to the caller. UX:
 * urgency + status shown as colour-AND-text badges (accessibility), SLA "auto-escalates in …" is
 * surfaced with time remaining + owner tier, and a full escalation timeline gives auditability.
 */
import { useMemo, useState } from 'react';
import { PageHeader, StatCard, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/lib/toast/ToastProvider';
import { useTickets, useTicket, useCreateTicket, useCommentTicket, useSetTicketStatus, useEscalateTicket } from '@/lib/ops/hooks';
import type { Ticket } from '@/lib/ops/endpoints';
import { ApiError } from '@/lib/api/client';

const URGENCY: Record<string, string> = {
  critical: 'border-down/40 bg-down/10 text-down', high: 'border-warn/40 bg-warn/10 text-warn',
  medium: 'border-accent/40 bg-accent/10 text-accent', low: 'border-border bg-surface-2 text-muted',
};
const STATUS: Record<string, string> = {
  open: 'border-accent/40 bg-accent/10 text-accent', in_progress: 'border-warn/40 bg-warn/10 text-warn',
  resolved: 'border-up/40 bg-up/10 text-up', closed: 'border-border bg-surface-2 text-muted',
};
const Badge = ({ cls, children }: { cls: string; children: React.ReactNode }) =>
  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;

function sla(t: Ticket): { label: string; tone: string } {
  if (t.status === 'resolved' || t.status === 'closed') return { label: '—', tone: 'text-muted' };
  if (t.escalationLevel >= 1) return { label: 'at System admin', tone: 'text-muted' };
  if (!t.slaDueAtMs) return { label: '—', tone: 'text-muted' };
  const mins = Math.round((t.slaDueAtMs - Date.now()) / 60000);
  if (mins <= 0) return { label: 'escalating…', tone: 'text-down' };
  const lbl = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  return { label: `auto-escalates in ${lbl}`, tone: mins <= 30 ? 'text-down' : mins <= 120 ? 'text-warn' : 'text-muted' };
}

export function TicketsView({ title, subtitle }: { title: string; subtitle: string }) {
  const toast = useToast();
  const [status, setStatus] = useState(''); const [urgency, setUrgency] = useState('');
  const q = useTickets({ status: status || undefined, urgency: urgency || undefined, limit: 100 });
  const tickets = useMemo(() => q.data?.tickets ?? [], [q.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [urg, setUrg] = useState('medium');
  const create = useCreateTicket();
  const err = (e: unknown) => toast.push({ tone: 'error', title: 'Failed', description: e instanceof ApiError ? e.message : String(e) });

  const counts = useMemo(() => ({
    open: tickets.filter((t) => t.status === 'open').length,
    inprog: tickets.filter((t) => t.status === 'in_progress').length,
    escalated: tickets.filter((t) => t.escalationLevel >= 1 && (t.status === 'open' || t.status === 'in_progress')).length,
  }), [tickets]);

  async function submit() {
    if (!subject.trim()) return err(new Error('Subject is required.'));
    try { await create.mutateAsync({ subject: subject.trim(), body: body.trim(), urgency: urg }); toast.push({ tone: 'success', title: 'Ticket raised' }); setCreateOpen(false); setSubject(''); setBody(''); setUrg('medium'); }
    catch (e) { err(e); }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} subtitle={subtitle} actions={<Button onClick={() => setCreateOpen(true)}>New ticket</Button>} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Open" value={counts.open} />
        <StatCard label="In progress" value={counts.inprog} tone={counts.inprog > 0 ? 'warn' : 'default'} />
        <StatCard label="Escalated to System" value={counts.escalated} tone={counts.escalated > 0 ? 'down' : 'default'} />
      </div>

      <div className="flex flex-wrap gap-2">
        <select className="rounded-brand border border-border bg-surface px-3 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
        </select>
        <select className="rounded-brand border border-border bg-surface px-3 py-2 text-sm" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
          <option value="">All urgencies</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
      </div>

      <Section title="Tickets">
        {q.isLoading ? <Card><div className="p-6 text-sm text-muted">Loading…</div></Card>
          : tickets.length === 0 ? <Card><div className="flex flex-col items-start gap-3 p-6"><p className="text-sm text-muted">No tickets.</p><Button onClick={() => setCreateOpen(true)}>Raise a ticket</Button></div></Card>
          : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr><Th>Subject</Th><Th>Urgency</Th><Th>Status</Th><Th>Assignee</Th><Th>SLA</Th><Th className="text-right">Raised</Th></tr></thead>
              <tbody>
                {tickets.map((t) => { const s = sla(t); return (
                  <tr key={t.id} className="cursor-pointer border-t border-border hover:bg-surface-2" onClick={() => setOpenId(t.id)}>
                    <Td><span className="font-medium">{t.subject}</span></Td>
                    <Td><Badge cls={URGENCY[t.urgency]!}>{t.urgency}</Badge></Td>
                    <Td><Badge cls={STATUS[t.status]!}>{t.status.replace('_', ' ')}</Badge></Td>
                    <Td className="text-xs text-muted">{t.escalationLevel >= 1 ? 'System admin' : 'Platform admin'}</Td>
                    <Td className={`text-xs ${s.tone}`}>{s.label}</Td>
                    <Td className="text-right text-xs text-muted">{new Date(t.createdAtMs).toLocaleString()}</Td>
                  </tr>); })}
              </tbody>
            </table>
          </TableWrap>)}
      </Section>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Raise a ticket"
        description="Assigned to your platform admin; auto-escalates to the System admin if the SLA lapses."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={create.isPending}>Raise ticket</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Subject" placeholder="Short summary of the issue" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Select label="Urgency" value={urg} onChange={(e) => setUrg(e.target.value)}>
            <option value="critical">Critical — 1h SLA</option>
            <option value="high">High — 4h SLA</option>
            <option value="medium">Medium — 24h SLA</option>
            <option value="low">Low — 72h SLA</option>
          </Select>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Reason / details</span>
            <textarea
              className="min-h-28 w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-fg outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/40"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What's wrong, what you've tried, impact…"
            />
          </label>
        </div>
      </Modal>

      {openId ? <TicketDetail id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function TicketDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const q = useTicket(id); const comment = useCommentTicket(id); const setStatus = useSetTicketStatus(id); const escalate = useEscalateTicket(id);
  const [note, setNote] = useState('');
  const err = (e: unknown) => toast.push({ tone: 'error', title: 'Failed', description: e instanceof ApiError ? e.message : String(e) });
  const d = q.data; const t = d?.ticket;

  async function act(fn: () => Promise<unknown>, ok: string) { try { await fn(); toast.push({ tone: 'success', title: ok }); } catch (e) { err(e); } }

  return (
    <Modal open onClose={onClose} title={t ? t.subject : 'Ticket'}>
      {!t ? <div className="p-4 text-sm text-muted">Loading…</div> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge cls={URGENCY[t.urgency]!}>{t.urgency}</Badge>
            <Badge cls={STATUS[t.status]!}>{t.status.replace('_', ' ')}</Badge>
            <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">{t.escalationLevel >= 1 ? 'System admin' : 'Platform admin'}</span>
          </div>
          {t.body ? <p className="whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-3 text-sm">{t.body}</p> : null}

          {d!.escalations.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Escalation history</h4>
              {d!.escalations.map((e) => (
                <div key={e.id} className="text-xs text-muted">• {new Date(e.createdAtMs).toLocaleString()} — {e.reason === 'auto' ? 'Auto (SLA breached)' : 'Manual'}: {e.fromRole} → {e.toRole}{e.note ? ` · ${e.note}` : ''}</div>
              ))}
            </div>) : null}

          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Thread</h4>
            <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
              {d!.comments.length === 0 ? <p className="text-xs text-muted">No comments yet.</p> :
                d!.comments.map((c) => <div key={c.id} className="rounded-lg border border-border bg-surface p-2 text-sm"><div className="text-xs text-muted">{c.authorRole} · {new Date(c.createdAtMs).toLocaleString()}</div>{c.body}</div>)}
            </div>
            <div className="flex gap-2">
              <Input placeholder="Add a comment…" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button onClick={async () => { if (note.trim()) { await act(() => comment.mutateAsync(note.trim()), 'Comment added'); setNote(''); } }} disabled={comment.isPending}>Send</Button>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            {t.escalationLevel < 1 && t.status !== 'resolved' && t.status !== 'closed'
              ? <Button variant="down" onClick={() => act(() => escalate.mutateAsync(undefined), 'Escalated to System admin')} disabled={escalate.isPending}>Escalate to System</Button> : null}
            {t.status !== 'in_progress' && t.status !== 'resolved' && t.status !== 'closed'
              ? <Button variant="outline" onClick={() => act(() => setStatus.mutateAsync({ status: 'in_progress' }), 'Marked in progress')}>Mark in progress</Button> : null}
            {t.status !== 'resolved' && t.status !== 'closed'
              ? <Button onClick={() => act(() => setStatus.mutateAsync({ status: 'resolved' }), 'Resolved')}>Resolve</Button> : null}
            {t.status === 'resolved' ? <Button variant="outline" onClick={() => act(() => setStatus.mutateAsync({ status: 'closed' }), 'Closed')}>Close</Button> : null}
          </div>
        </div>)}
    </Modal>
  );
}
