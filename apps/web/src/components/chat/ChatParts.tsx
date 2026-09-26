'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { mediaUrl, compressImage, type ChatMessageDto } from '@/lib/chat/liveChat';
import { DIcon } from '@/components/game/digits/icons';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * CHAT-1: the message list shared by the player panel and the back-office inbox. `mine` decides which
 * side a message sits on; system lines are centred. Photos open full size, videos and voice notes play
 * inline. Scrolls to the newest message when one arrives.
 */
export function ChatMessages({ messages, mine, header }: { messages: ChatMessageDto[]; mine: (m: ChatMessageDto) => boolean; header?: React.ReactNode }) {
  const end = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const lastId = messages.at(-1)?.id;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lastId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3" aria-live="polite" aria-label="Messages">
      {header}
      {messages.map((m) => {
        if (m.authorRole === 'system') return <p key={m.id} className="my-1 text-center text-[11px] text-muted">{m.body} · {time(m.createdAt)}</p>;
        const me = mine(m);
        return (
          <div key={m.id} className={cn('flex max-w-[82%] flex-col gap-1', me ? 'items-end self-end' : 'items-start self-start')}>
            {!me && m.authorName ? <span className="px-1 text-[10px] font-semibold text-muted">{m.authorName}</span> : null}
            <div className={cn('overflow-hidden rounded-2xl text-[13px] leading-snug', me ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md border border-border bg-surface-2 text-fg')}>
              {m.attachment ? (
                m.attachment.kind === 'image' ? (
                  <button type="button" onClick={() => setZoom(mediaUrl(m.attachment!.url))} className="block" aria-label="Open photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mediaUrl(m.attachment.url)} alt="Photo" className="max-h-60 w-full max-w-[260px] object-cover" loading="lazy" />
                  </button>
                ) : m.attachment.kind === 'video' ? (
                  <video src={mediaUrl(m.attachment.url)} controls playsInline className="max-h-64 w-full max-w-[260px] bg-black" />
                ) : (
                  <audio src={mediaUrl(m.attachment.url)} controls className="w-60 max-w-full p-1" />
                )
              ) : null}
              {m.body ? <p className="whitespace-pre-wrap break-words px-3 py-2">{m.body}</p> : null}
            </div>
            <span className="px-1 text-[10px] text-muted">{time(m.createdAt)}</span>
          </div>
        );
      })}
      <div ref={end} />
      {zoom ? <ZoomEscape onClose={() => setZoom(null)} /> : null}
      {zoom ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="Photo" className="max-h-full max-w-full rounded-lg" />
        </div>
      ) : null}
    </div>
  );
}

/** Escape closes the zoomed photo only — not the whole chat (BUGLOG #107). */
function ZoomEscape({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return null;
}

/** Pick the best recording format this browser supports (all are on the server's allow-list). */
function recorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) return m;
  return undefined;
}

/**
 * CHAT-1: composer — attach a photo or short video, record a voice note (tap the mic to start, tap
 * again to send; Cancel discards), type and send. File size limits match the server's.
 */
export function ChatComposer({ onSend, busy, disabled, placeholder = 'Message' }: {
  onSend: (v: { body: string; file?: Blob | null }) => Promise<unknown>; busy?: boolean; disabled?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rec, setRec] = useState<{ r: MediaRecorder; started: number } | null>(null);
  const [secs, setSecs] = useState(0);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSecs(Math.round((Date.now() - rec.started) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [rec]);

  // Clear only what was sent (BUGLOG #104: a voice note wiped the typed draft and a staged photo, and
  // text typed during an upload was lost). The staged file is cleared only if it is the one sent.
  const send = async (body: string, f?: Blob | null) => {
    setErr(null);
    try {
      await onSend({ body, file: f ?? null });
      if (body) setText((t) => (t.trim() === body.trim() ? '' : t));
      if (f) setFile((cur) => (cur === f ? null : cur));
    } catch (e) { setErr((e as Error).message || 'Could not send. Try again.'); }
  };

  // Closing the chat while recording must release the microphone (BUGLOG #104).
  const recRef = useRef<MediaRecorder | null>(null);
  recRef.current = rec?.r ?? null;
  useEffect(() => () => {
    const r = recRef.current;
    if (r && r.state !== 'inactive') { cancelled.current = true; try { r.stop(); } catch { /* ignore */ } }
  }, []);

  const pick = async (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (f.type.startsWith('video/') && f.size > 15 * 1024 * 1024) { setErr('Videos can be up to 15 MB.'); return; }
    if (f.type.startsWith('image/')) {
      const small = await compressImage(f);
      if (small.size > 5 * 1024 * 1024) { setErr('Photos can be up to 5 MB.'); return; }
      setFile(new File([small], f.name, { type: small.type || f.type }));
      return;
    }
    if (!f.type.startsWith('video/')) { setErr('Send a photo or a short video.'); return; }
    setFile(f);
  };

  const startRec = async () => {
    setErr(null);
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) { setErr('Voice notes are not supported on this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = []; cancelled.current = false;
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (cancelled.current || !chunks.current.length) return;
        const blob = new Blob(chunks.current, { type: mime.split(';')[0] ?? mime });
        if (blob.size > 3 * 1024 * 1024) { setErr('Voice notes can be up to 3 MB (about 3 minutes).'); return; }
        void send('', blob);
      };
      r.start(250);
      setRec({ r, started: Date.now() }); setSecs(0);
    } catch { setErr('Allow microphone access to record a voice note.'); }
  };
  const stopRec = (cancel: boolean) => { if (!rec) return; cancelled.current = cancel; rec.r.stop(); setRec(null); };

  const canSend = !busy && !disabled && (text.trim().length > 0 || !!file);
  return (
    <div className="border-t border-border p-2.5">
      {file ? (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-surface-2 px-3 py-1.5 text-[12px] text-fg">
          <span className="truncate">{file.type.startsWith('video/') ? 'Video' : 'Photo'}: {file.name}</span>
          <button type="button" onClick={() => setFile(null)} aria-label="Remove attachment" className="text-muted hover:text-fg"><DIcon name="close" className="h-3.5 w-3.5" /></button>
        </div>
      ) : null}
      {err ? <p className="mb-1.5 text-[12px] text-down" role="alert">{err}</p> : null}
      {rec ? (
        <div className="flex items-center gap-2">
          <span className="flex flex-1 items-center gap-2 rounded-xl bg-down/10 px-3 py-2.5 text-[13px] font-semibold text-down">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-down" />Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
          </span>
          <button type="button" onClick={() => stopRec(true)} className="rounded-lg px-3 py-2 text-[12px] font-semibold text-muted hover:text-fg">Cancel</button>
          <button type="button" onClick={() => stopRec(false)} aria-label="Send voice note" className="grid h-10 w-10 place-items-center rounded-full bg-accent text-accent-fg"><DIcon name="send" className="h-4 w-4" /></button>
        </div>
      ) : (
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (canSend) void send(text.trim(), file); }}>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" className="hidden"
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} aria-label="Attach a photo or video" />
          <button type="button" onClick={() => input.current?.click()} disabled={disabled} aria-label="Attach a photo or video" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
            <DIcon name="paperclip" className="h-[18px] w-[18px]" />
          </button>
          <button type="button" onClick={() => void startRec()} disabled={disabled} aria-label="Record a voice note" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
            <DIcon name="mic" className="h-[18px] w-[18px]" />
          </button>
          <input value={text} onChange={(e) => setText(e.target.value.slice(0, 4000))} placeholder={placeholder} disabled={disabled} aria-label="Message"
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 text-[14px] text-fg outline-none focus:border-accent" />
          <button type="submit" disabled={!canSend} aria-label="Send" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg transition disabled:opacity-40">
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" /> : <DIcon name="send" className="h-4 w-4" />}
          </button>
        </form>
      )}
    </div>
  );
}
