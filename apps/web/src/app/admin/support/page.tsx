'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { formatRelativeTime } from '@/lib/format';
import { PageHeader, TableWrap, Th, Td, Empty, Toolbar, FilterSelect } from '@/components/admin/ui';
import { useSupportConversations, useSupportThread } from '@/lib/support/operatorHooks';
import type { SupportConversationDto, SupportMessageDto } from '@/lib/support/types';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
];

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
};

/**
 * Operator support inbox (docs/11, migration 0057). Lists the brand's recorded conversations
 * (RLS keeps a site admin to their own brand; platform_superadmin sees all) and opens a full
 * transcript with the knowledge-base sources and confidence the assistant recorded per turn.
 */
export default function SupportInboxPage() {
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useSupportConversations(100);

  const rows = useMemo(() => {
    const items = q.data?.items ?? [];
    return status ? items.filter((c) => c.status === status) : items;
  }, [q.data, status]);

  return (
    <>
      <PageHeader
        title="Support inbox"
        subtitle="Every visitor inquiry, answered by the assistant and grounded in your knowledge base. Escalations are flagged for follow up."
        actions={
          <Toolbar>
            <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          </Toolbar>
        }
      />

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load conversations" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No conversations" description={status ? 'None match this filter.' : 'No support conversations yet.'} />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Who</Th>
              <Th>Status</Th>
              <Th>Contact</Th>
              <Th>Last activity</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-t border-border transition hover:bg-surface-2"
                onClick={() => setOpenId(c.id)}
              >
                <Td>
                  <div className="flex flex-col">
                    <span className="font-medium text-fg">{whoLabel(c)}</span>
                    <span className="text-xs text-muted">{c.id.slice(0, 8)}</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={c.status} />
                    {c.escalated ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">escalated</span> : null}
                  </div>
                </Td>
                <Td>
                  <span className="text-sm text-muted">{c.contactEmail ?? c.contactPhone ?? 'none'}</span>
                </Td>
                <Td>
                  <span className="text-sm text-muted">{formatRelativeTime(ms(c.lastAt))}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <ThreadModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function whoLabel(c: SupportConversationDto): string {
  if (c.userId) return `Player ${c.userId.slice(0, 8)}`;
  if (c.visitorId) return `Visitor ${c.visitorId.slice(0, 8)}`;
  return 'Anonymous visitor';
}

function ThreadModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useSupportThread(id);
  return (
    <Modal open={!!id} onClose={onClose} title="Conversation transcript">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Conversation</h2>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted transition hover:bg-border hover:text-fg" aria-label="Close">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError || !q.data ? (
          <Empty title="Couldn't load transcript" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <StatusBadge status={q.data.conversation.status} />
              {q.data.conversation.contactEmail ? <span>{q.data.conversation.contactEmail}</span> : null}
              {q.data.conversation.contactPhone ? <span>{q.data.conversation.contactPhone}</span> : null}
            </div>
            {q.data.messages.length === 0 ? (
              <Empty title="No messages" />
            ) : (
              q.data.messages.map((m) => <OperatorBubble key={m.id} m={m} />)
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function OperatorBubble({ m }: { m: SupportMessageDto }) {
  const isUser = m.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${isUser ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg'}`}>
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
        {m.role === 'assistant' ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {typeof m.confidence === 'number' ? (
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted">
                confidence {(m.confidence * 100).toFixed(0)}%
              </span>
            ) : null}
            {m.sources.map((s, i) => (
              <span key={`${s.source}-${i}`} className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted" title={s.source}>
                {s.heading ?? s.source}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
