'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { useSupportChat, type ChatMessage } from '@/lib/support/useSupportChat';
import { sourceLabel } from '@/lib/support/format';

/**
 * Tawk-style floating support widget. A brand-accented launcher opens a compact chat panel that
 * talks to the RAG support API (POST /support/*). Anonymous by default; a logged-in player's
 * token is attached automatically to attribute and brand-scope the conversation. Answers show
 * their knowledge-base sources; when the assistant is unsure it offers a human handoff.
 *
 * Rendered globally by AppShell on player-facing surfaces only (never /admin or /platform).
 */
export function SupportWidget() {
  const hydrated = useHydrated();
  const brand = useBrand();
  const token = useSession((s) => s.token);

  const open = useSupportChat((s) => s.open);
  const setOpen = useSupportChat((s) => s.setOpen);
  const messages = useSupportChat((s) => s.messages);
  const sending = useSupportChat((s) => s.sending);
  const needsEscalation = useSupportChat((s) => s.needsEscalation);
  const escalated = useSupportChat((s) => s.escalated);
  const send = useSupportChat((s) => s.send);
  const escalate = useSupportChat((s) => s.escalate);

  const [draft, setDraft] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, sending]);

  if (!hydrated) return null;

  const onSend = () => {
    const text = draft;
    setDraft('');
    void send(text, token);
  };

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg transition hover:opacity-90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-6 md:right-6',
        )}
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Panel */}
      {open ? (
        <div
          role="dialog"
          aria-label={`${brand.name} support chat`}
          className={cn(
            'fixed right-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl',
            'bottom-[calc(9.5rem+env(safe-area-inset-bottom))] md:bottom-24 md:right-6',
            'w-[min(24rem,calc(100vw-2rem))] h-[min(32rem,calc(100dvh-12rem))]',
          )}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-3">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-fg">{brand.name} support</span>
              <span className="text-xs text-muted">Ask anything, we usually answer instantly.</span>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-muted transition hover:bg-border hover:text-fg"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 ? (
              <div className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
                Hi, welcome to {brand.name}. How can we help today? You can ask about deposits, withdrawals, how the
                game works, bonuses, or your account.
              </div>
            ) : (
              messages.map((m) => <Bubble key={m.id} m={m} />)
            )}
            {sending ? (
              <div className="flex w-fit items-center gap-1 rounded-2xl bg-surface-2 px-3 py-2" aria-label="Assistant is typing">
                <Dot /> <Dot /> <Dot />
              </div>
            ) : null}
          </div>

          {needsEscalation && !escalated ? (
            <EscalateForm onSubmit={(contact) => escalate(contact, token)} />
          ) : null}

          <form
            className="flex items-center gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type your message"
              aria-label="Message"
              maxLength={1000}
              className="h-11 flex-1 rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent"
            />
            <Button type="submit" size="sm" disabled={sending || draft.trim().length === 0} aria-label="Send">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          </form>
        </div>
      ) : null}
    </>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
          isUser
            ? 'bg-accent text-accent-fg'
            : m.error
              ? 'bg-surface-2 text-down'
              : 'bg-surface-2 text-fg',
        )}
      >
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
        {m.citations && m.citations.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {m.citations.map((c, i) => (
              <span
                key={`${c.source}-${i}`}
                className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted"
                title={c.source}
              >
                {c.heading ?? sourceLabel(c.source)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EscalateForm({ onSubmit }: { onSubmit: (contact: { email?: string; phone?: string }) => Promise<boolean> }) {
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 border-t border-border bg-surface-2 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!email.trim() && !phone.trim()) {
          setErr('Add an email or phone so we can reach you.');
          return;
        }
        setBusy(true);
        setErr(null);
        const contact: { email?: string; phone?: string } = {};
        if (email.trim()) contact.email = email.trim();
        if (phone.trim()) contact.phone = phone.trim();
        const ok = await onSubmit(contact);
        setBusy(false);
        if (!ok) setErr('Could not submit right now, please try again.');
      }}
    >
      <span className="text-xs font-medium text-fg">Want a human to follow up? Leave a contact.</span>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
        />
      </div>
      {err ? <span className="text-xs text-down">{err}</span> : null}
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        {busy ? 'Sending...' : 'Request a callback'}
      </Button>
    </form>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />;
}
