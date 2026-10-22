'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useDisplayMoney } from '@/lib/money';
import { ApiError } from '@/lib/api/client';
import { useMarketerLive, useLiveSessionActions } from '@/lib/affiliate/hooks';

/**
 * Start Live / End Live, and what the running session has earned (docs/55).
 *
 * The figure is a REPORT. Commission attribution is unchanged by going live: this counts the
 * commission this marketer has already earned on deposits inside the session's window, so an
 * operator who pays per session has a number to pay against. Nothing here moves money, and the
 * panel says as much, because a marketer looking at a money figure deserves to know what it is.
 *
 * Hidden entirely when the brand has not enabled live sessions — a marketer on a brand that does
 * not run them should not see a control that would refuse.
 */
export function LiveSessionPanel() {
  const { data, isPending } = useMarketerLive(true);
  const { start, end, extend } = useLiveSessionActions();
  const { fmt } = useDisplayMoney();
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  if (isPending || !data?.settings.enabled) return null;

  const cur = data.current;
  const running = cur?.live === true;

  const act = (p: Promise<unknown>) => {
    setErr(null);
    p.catch((e) => setErr(e instanceof ApiError ? REFUSALS[e.code] ?? e.message : 'Something went wrong.'));
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          {running ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-down" /> : null}
          <h3 className="min-w-0 truncate text-sm font-semibold text-fg">{running ? 'You are live' : 'Go live'}</h3>
        </div>
        {running && cur ? (
          <span className="shrink-0 whitespace-nowrap text-xs text-muted">ends {new Date(cur.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        ) : null}
      </div>

      {running && cur ? (
        <>
          {/* One figure per row on a phone. Halved, a 320px card leaves each card ~110px of inner
              width, and a formatted figure ("KES 1,234,567") plus its uppercase label needs more
              than that — the number would be clipped or the cards pushed out of the panel. */}
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Figure label="Earned this session" value={fmt(cur.earnedCents)} tone="up" />
            <Figure label="Deposits counted" value={String(cur.deposits)} />
          </div>
          {/* The one sentence that stops this number being misread as a different kind of pay. */}
          <p className="mb-3 text-[11px] leading-relaxed text-muted">
            Your commission is earned the same way whether or not you are live. This is what you have
            earned so far from deposits made during this session, including {cur.marginMinutes} minutes
            either side.
          </p>
          {/* "+90m" is wider than "+30m", so the extend button keeps its natural width and End Live
              takes whatever is left instead of the pair overflowing the card. */}
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => act(end.mutateAsync())}
              disabled={end.isPending}
              className="h-11 min-w-0 flex-1 truncate rounded-lg bg-down px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {end.isPending ? 'Ending…' : 'End Live'}
            </button>
            <button
              type="button"
              onClick={() => act(extend.mutateAsync())}
              disabled={extend.isPending}
              className="h-11 shrink-0 whitespace-nowrap rounded-lg border border-border px-4 text-sm font-semibold text-fg disabled:opacity-50"
            >
              +{data.settings.extendMinutes}m
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="mb-1 block text-xs text-muted" htmlFor="live-url">Stream link (optional)</label>
          <input
            id="live-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.tiktok.com/@you/live"
            className="mb-3 h-11 w-full min-w-0 rounded-lg border border-border bg-bg px-3 text-base text-fg outline-none focus:border-accent sm:text-sm"
          />
          <button
            type="button"
            onClick={() => act(start.mutateAsync(url.trim() || undefined))}
            disabled={start.isPending}
            className="h-11 w-full rounded-lg bg-accent text-sm font-semibold text-accent-fg disabled:opacity-50"
          >
            {start.isPending ? 'Starting…' : 'Start Live'}
          </button>
          <p className="mt-2 text-[11px] text-muted">
            Sessions run {data.settings.sessionMinutes} minutes and end on their own if you forget.
          </p>
        </>
      )}

      {err ? <p className="mt-2 break-words text-xs text-down">{err}</p> : null}

      {data.history.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 text-xs font-semibold text-muted">Recent sessions</div>
          {/* The amount is each row's point, so it keeps its full width and the date truncates. */}
          <ul className="space-y-1.5">
            {data.history.filter((h) => !h.live).slice(0, 5).map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate text-muted">
                  {new Date(h.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}{' '}
                  {new Date(h.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={cn('shrink-0 whitespace-nowrap font-semibold tabular-nums', h.earnedCents > 0 ? 'text-up' : 'text-fg')}>{fmt(h.earnedCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'up' }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg p-3">
      <div className="text-[11px] uppercase leading-snug tracking-wide text-muted">{label}</div>
      {/* A currency symbol and seven digits of grouped figure have to wrap rather than run past the
          card's edge, and tabular digits keep the two cards' figures on the same rhythm. */}
      <div className={cn('mt-0.5 break-words text-lg font-bold leading-tight tabular-nums', tone === 'up' ? 'text-up' : 'text-fg')}>{value}</div>
    </div>
  );
}

/** The refusals the server can send, in the marketer's words rather than a code. */
const REFUSALS: Record<string, string> = {
  LIVE_DISABLED: 'Live sessions are off for this brand.',
  ALREADY_LIVE: 'You already have a session running.',
  DAILY_LIMIT_REACHED: 'You have used all your sessions for today.',
  NOT_LIVE: 'You are not live right now.',
  LIVE_UNAVAILABLE: 'Live sessions are not available yet.',
};
