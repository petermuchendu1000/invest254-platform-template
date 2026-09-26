'use client';

import { useEffect } from 'react';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { useEffectiveRole } from '@/lib/auth/can';
import { useAuthUi } from '@/lib/auth/ui';
import { useLiveChat, usePlayerChat, useSendChat, useMarkChatRead, useOnNewMessages } from '@/lib/chat/liveChat';
import { play } from '@/lib/sound/sound';
import { ChatComposer, ChatMessages } from '@/components/chat/ChatParts';
import { DIcon } from '@/components/game/digits/icons';

const waLink = (n: string) => `https://wa.me/${n.replace(/[^0-9]/g, '')}`;

/**
 * CHAT-1: Customer Care panel (digits broker mock). Bottom-left card on desktop, full-screen sheet on
 * phones. The greeting names the brand and its WhatsApp / email; messages poll every 3s while open
 * (20s closed, for the unread badge). New agent replies play the message sound and are marked read
 * while the panel is open.
 */
export function LiveChatPanel() {
  const open = useLiveChat((s) => s.open);
  const setOpen = useLiveChat((s) => s.setOpen);
  const token = useSession((s) => s.token);
  const openAuth = useAuthUi((s) => s.openAuth);
  const brand = useBrand();
  const role = useEffectiveRole();
  const customer = role === 'player' || role === 'marketer';
  const q = usePlayerChat(customer, open ? 3000 : 20000);
  const send = useSendChat();
  const read = useMarkChatRead();
  const msgs = q.data?.messages ?? [];
  const unread = q.data?.thread?.playerUnread ?? 0;

  useOnNewMessages(q.data?.messages, (m) => m.authorRole === 'agent', () => play('message'));
  useEffect(() => { if (open && unread > 0) read.mutate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, unread]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const c = q.data?.contacts;
  const whatsapp = c?.whatsapp ?? brand.supportWhatsapp ?? null;
  const email = c?.email ?? brand.supportEmail ?? null;
  const name = c?.brandName ?? brand.name;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-surface sm:inset-auto sm:bottom-4 sm:left-4 sm:h-[600px] sm:max-h-[calc(100dvh-2rem)] sm:w-[420px] sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl"
      role="dialog" aria-label="Customer care chat">
      <header className="flex items-center gap-3 rounded-t-2xl border-b border-border bg-gradient-to-r from-accent/15 to-transparent px-4 py-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-accent text-accent-fg"><DIcon name="headset" className="h-5 w-5" /></span>
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-fg">Customer Care</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted"><span className="h-1.5 w-1.5 rounded-full bg-up" />{name}</div>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-fg"><DIcon name="close" className="h-4 w-4" /></button>
      </header>

      {!token ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <button type="button" onClick={() => { setOpen(false); openAuth('login'); }} className="rounded-lg bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-fg">Log in</button>
          {whatsapp ? <a href={waLink(whatsapp)} target="_blank" rel="noopener noreferrer" className="text-[13px] text-accent underline">Or WhatsApp {whatsapp}</a> : null}
        </div>
      ) : (
        <>
          <ChatMessages
            messages={msgs}
            mine={(m) => m.authorRole === 'player'}
            header={
              whatsapp || email ? (
                <div className="mb-1 flex flex-wrap items-center justify-center gap-2 text-[12px]">
                  {whatsapp ? <a href={waLink(whatsapp)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-up"><DIcon name="whatsapp" className="h-3.5 w-3.5" />WhatsApp {whatsapp}</a> : null}
                  {email ? <a href={`mailto:${email}`} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-muted hover:text-fg"><DIcon name="mail" className="h-3.5 w-3.5" />{email}</a> : null}
                </div>
              ) : null
            }
          />
          {q.data?.thread?.status === 'resolved' ? <p className="px-4 pb-1 text-center text-[11px] text-muted">Resolved</p> : null}
          <ChatComposer busy={send.isPending} onSend={(v) => send.mutateAsync(v)} />
        </>
      )}
    </div>
  );
}

/** Unread replies for the Live Chat buttons' badge. */
export function useLiveChatUnread(): number {
  const role = useEffectiveRole();
  const q = usePlayerChat(role === 'player' || role === 'marketer', 20000);
  return q.data?.thread?.playerUnread ?? 0;
}

/** Floating chat button for brands on the classic trade screen (the digits shell has its own buttons). */
export function LiveChatLauncher() {
  const setOpen = useLiveChat((s) => s.setOpen);
  const open = useLiveChat((s) => s.open);
  const unread = useLiveChatUnread();
  if (open) return null;
  return (
    <button type="button" onClick={() => setOpen(true)} aria-label={`Live chat${unread ? ` (${unread} new)` : ''}`}
      className="fixed bottom-6 right-4 z-40 hidden h-12 w-12 place-items-center rounded-full bg-accent text-accent-fg shadow-[0_6px_22px_-6px_var(--pp-accent)] md:grid">
      <DIcon name="chat" className="h-5 w-5" />
      {unread ? <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-down px-1 text-[10px] font-bold text-white">{unread}</span> : null}
    </button>
  );
}
