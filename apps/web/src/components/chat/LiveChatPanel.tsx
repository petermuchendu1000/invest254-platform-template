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
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import { cn } from '@/lib/cn';

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
  /**
   * MetaTrader has a Chat screen of its own, so this is a real screen to match rather than an
   * invented one. The thread and composer are not rewritten: re-pointing the theme tokens on the
   * panel repaints the whole tree (see lib/ui/mt5Tokens), and only the title bar is replaced. The
   * accent is MetaTrader's BLUE here — your own messages are your voice, not a confirmation.
   */
  const mt5 = useTerminalSkin();
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
    <div
      className={cn(
        'fixed inset-0 z-[60] flex flex-col bg-surface sm:inset-auto sm:bottom-4 sm:left-4 sm:h-[600px] sm:max-h-[calc(100dvh-2rem)] sm:w-[420px] sm:border sm:border-border sm:shadow-2xl',
        mt5 ? 'sm:rounded' : 'sm:rounded-2xl',
      )}
      {...(mt5 ? { style: MT5_TOKENS } : {})}
      role="dialog" aria-label="Customer care chat"
    >
      {/* MetaTrader's screens are titled by a solid blue band, not a tinted gradient. */}
      <header className={cn(
        'flex items-center gap-3 border-b border-border',
        mt5 ? 'bg-[var(--mt5-blue)] px-3 py-2.5' : 'rounded-t-2xl bg-gradient-to-r from-accent/15 to-transparent px-4 py-3',
      )}>
        {mt5 ? null : <span className="grid h-10 w-10 place-items-center rounded-full bg-accent text-accent-fg"><DIcon name="headset" className="h-5 w-5" /></span>}
        <div className="flex-1">
          <div className={cn('font-semibold', mt5 ? 'text-[15px] leading-tight text-white' : 'text-[14px] text-fg')}>Customer Care</div>
          <div className={cn('flex items-center gap-1.5 text-[11px]', mt5 ? 'text-white/75' : 'text-muted')}>
            {mt5 ? null : <span className="h-1.5 w-1.5 rounded-full bg-up" />}{name}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          className={cn('grid h-9 w-9 place-items-center rounded-lg', mt5 ? 'text-white hover:bg-white/20' : 'text-muted hover:text-fg')}
        >
          <DIcon name="close" className="h-4 w-4" />
        </button>
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
  const mt5 = useTerminalSkin();
  if (open) return null;
  return (
    <button type="button" onClick={() => setOpen(true)} aria-label={`Live chat${unread ? ` (${unread} new)` : ''}`}
      className={cn(
        'fixed bottom-6 right-4 z-40 hidden h-12 w-12 place-items-center rounded-full md:grid',
        /**
         * Lifted clear of the trading controls on a SHORT screen, which is a phone on its side.
         *
         * The launcher is `md:`-gated, so portrait never draws it, but a phone in landscape is
         * 800x360 or 844x390 and that is wide enough: at both sizes the 48x48 button landed at
         * (736,288) / (780,318), on top of the one-click panel's BUY block
         * (MT5OneClickPanel.tsx:109, measured at (462,289,330,51)). It covered 13% of BUY, and
         * every pixel of BUY's right-hand end opened live chat instead of the order ticket, which
         * `document.elementFromPoint` reported as the launcher rather than the button. The panel is
         * 72px of the bottom edge, so 96px of offset clears it with 24px to spare and leaves the
         * launcher over bare chart: MetaTrader's landscape is a full-screen chart with no controls
         * of its own down there ("rotate to landscape = full-screen mode, automatically",
         * docs/mt5/04-mobile-app.md:187). It stays a tap away, which is the point of keeping it.
         */
        '[@media(max-height:480px)]:bottom-24',
        // The one brand-green element left floating over the terminal.
        mt5 ? 'bg-[var(--mt5-blue)] text-white shadow-lg shadow-black/40' : 'bg-accent text-accent-fg shadow-[0_6px_22px_-6px_var(--pp-accent)]',
      )}>
      <DIcon name="chat" className="h-5 w-5" />
      {unread ? <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--mt5-red)] px-1 text-[10px] font-bold text-white">{unread}</span> : null}
    </button>
  );
}
