'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatAgo } from '@/lib/format';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { useChatThreads, useChatThread, useAgentReply, useAgentThreadAction, useOnNewMessages, type ChatThreadDto } from '@/lib/chat/liveChat';
import { play } from '@/lib/sound/sound';
import { ChatComposer, ChatMessages } from '@/components/chat/ChatParts';
import { DIcon } from '@/components/game/digits/icons';

const STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
] as const;

/**
 * CHAT-1: the back-office live chat inbox. Conversations on the left (unread first, then newest),
 * the selected conversation on the right with the reply box and Resolve / Reopen. Polls every few
 * seconds; a new player message plays the message sound. On phones the list and the conversation
 * are separate screens.
 */
export function LiveChatInbox() {
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const list = useChatThreads(status, q.trim());
  const items = list.data?.items ?? [];
  const totalUnread = items.reduce((n, t) => n + t.agentUnread, 0);
  const [prevUnread, setPrevUnread] = useState<number | null>(null);
  useEffect(() => {
    if (prevUnread !== null && totalUnread > prevUnread) play('message');
    setPrevUnread(totalUnread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalUnread]);

  return (
    <div className="grid min-h-[560px] grid-cols-1 overflow-hidden rounded-2xl border border-border bg-surface md:grid-cols-[320px_1fr]">
      <aside className={cn('flex min-h-0 flex-col border-border md:border-r', sel ? 'hidden md:flex' : 'flex')} aria-label="Conversations">
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="flex gap-1" role="tablist" aria-label="Status">
            {STATUSES.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={status === s.id} onClick={() => setStatus(s.id)}
                className={cn('flex-1 rounded-lg py-1.5 text-[12px] font-semibold transition', status === s.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                {s.label}
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or phone" aria-label="Search conversations"
            className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? <li className="p-4 text-sm text-muted">Loading…</li>
            : list.isError ? <li className="p-4 text-sm text-down">Couldn’t load conversations.</li>
            : items.length === 0 ? <li className="p-6 text-center text-sm text-muted">{status === 'open' ? 'No open conversations. New chats appear here.' : 'Nothing here.'}</li>
            : items.map((t) => <ThreadRow key={t.id} t={t} active={t.id === sel} onClick={() => setSel(t.id)} />)}
        </ul>
      </aside>
      <section className={cn('min-h-0 flex-col', sel ? 'flex' : 'hidden md:flex')} aria-label="Conversation">
        {sel ? <Conversation id={sel} onBack={() => setSel(null)} /> : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
            <DIcon name="chat" className="h-8 w-8" />
            <p className="text-sm">Pick a conversation to read and reply.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadRow({ t, active, onClick }: { t: ChatThreadDto; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined}
        className={cn('flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left transition', active ? 'bg-accent/10' : 'hover:bg-surface-2')}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-bold uppercase text-fg">{(t.username ?? '?').slice(0, 2)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className={cn('truncate text-[13px]', t.agentUnread ? 'font-bold text-fg' : 'font-medium text-fg')}>@{t.username ?? 'player'}</span>
            <span className="shrink-0 text-[10px] text-muted">{formatAgo(Date.parse(t.lastMessageAt))}</span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-muted">{t.lastPreview ?? '—'}</span>
            {t.agentUnread ? <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-fg">{t.agentUnread}</span>
              : t.status === 'resolved' ? <span className="shrink-0 text-[10px] text-muted">resolved</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function Conversation({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useChatThread(id);
  const reply = useAgentReply(id);
  const act = useAgentThreadAction(id);
  const toast = useToast();
  const t = q.data?.thread;
  useOnNewMessages(q.data?.messages, (m) => m.authorRole === 'player', () => {});
  useEffect(() => { if (t && t.agentUnread > 0) act.mutate({ kind: 'read' }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [t?.id, t?.agentUnread]);

  if (q.isLoading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (q.isError || !t) return <p className="p-4 text-sm text-down">Couldn’t load this conversation.</p>;
  const resolved = t.status === 'resolved';
  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-lg p-1 text-muted hover:text-fg md:hidden" aria-label="Back to conversations">←</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-fg">@{t.username ?? 'player'}</div>
          <div className="text-[11px] text-muted">{t.phone ?? ''}{t.phone ? ' · ' : ''}started {formatAgo(Date.parse(t.createdAt))}</div>
        </div>
        <Link href={`/admin/users/${t.userId}`} className="hidden rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold text-fg hover:border-accent/50 sm:inline">Player</Link>
        <button type="button" disabled={act.isPending}
          onClick={() => act.mutate({ kind: 'status', status: resolved ? 'open' : 'resolved' }, {
            onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: e instanceof ApiError ? e.message : 'Try again.' }),
          })}
          className={cn('rounded-lg px-3 py-1.5 text-[12px] font-semibold', resolved ? 'border border-border text-fg' : 'bg-up/15 text-up')}>
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
      </header>
      <ChatMessages messages={q.data?.messages ?? []} mine={(m) => m.authorRole === 'agent'} />
      <ChatComposer busy={reply.isPending} placeholder={resolved ? 'Reply to reopen this conversation…' : 'Reply to the player…'} onSend={(v) => reply.mutateAsync(v)} />
    </>
  );
}
