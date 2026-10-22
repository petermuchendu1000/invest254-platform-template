'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/auth/session';
import { useEffectiveRole } from '@/lib/auth/can';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useCommunity, useCommunityVote, useCommunityAdmin } from '@/lib/affiliate/hooks';
import type { CommunityPostDto } from '@/lib/api/types';

/**
 * The brand's community channel (docs/56).
 *
 * A CHANNEL, not a group: operators post, everyone else reads and votes. There is no player
 * composer here and there is none on the server either — a brand's own channel carrying an
 * unmoderated player conversation is a support and compliance surface nobody asked for, and players
 * already have a voice in the trade screen's live chat.
 */
export function CommunityFeed() {
  const token = useSession((s) => s.token);
  const role = useEffectiveRole();
  const brand = useBrand();
  const { data, isPending } = useCommunity(!!token);
  const isAdmin = role === 'admin' || role === 'platform_admin' || role === 'platform_superadmin';

  if (!token) {
    return <Empty>Log in to see what {brand.name} is posting.</Empty>;
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-5">
      <header>
        <h1 className="break-words text-xl font-semibold tracking-tight text-fg">{brand.name} community</h1>
        <p className="mt-0.5 text-xs text-muted">Announcements, questions and live sessions from the team.</p>
      </header>

      {isAdmin ? <Composer /> : null}

      {isPending ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-surface" />)}
        </div>
      ) : !data?.items.length ? (
        <Empty>Nothing posted yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.items.map((p) => <Post key={p.id} post={p} isAdmin={isAdmin} />)}
        </ul>
      )}
    </div>
  );
}

function Post({ post, isAdmin }: { post: CommunityPostDto; isAdmin: boolean }) {
  const vote = useCommunityVote();
  const admin = useCommunityAdmin();

  return (
    <li className={cn('rounded-xl border bg-surface p-4', post.pinned ? 'border-accent/50' : 'border-border')}>
      {/* Badges, author and date wrap among themselves, and the admin row takes a line of its own
          until there is width for it: on a 320px phone the three actions and a long author name
          cannot share one line without one of them being pushed out of the card. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          {post.pinned ? <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-semibold text-accent">Pinned</span> : null}
          {post.kind === 'live' ? <span className="shrink-0 rounded bg-down/15 px-1.5 py-0.5 font-semibold text-down">Live</span> : null}
          <span className="min-w-0 max-w-full truncate">{post.author}</span>
          <span className="shrink-0" aria-hidden>·</span>
          <time className="shrink-0 whitespace-nowrap" dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</time>
        </div>
        {isAdmin ? (
          <div className="-my-1 flex w-full shrink-0 items-center justify-end gap-1 text-[11px] xs:w-auto">
            <AdminAction onClick={() => admin.pin.mutate({ id: post.id, pinned: !post.pinned })}>{post.pinned ? 'Unpin' : 'Pin'}</AdminAction>
            {post.kind === 'poll' ? (
              <AdminAction onClick={() => admin.close.mutate({ id: post.id, closed: !post.closed })}>{post.closed ? 'Reopen' : 'Close'}</AdminAction>
            ) : null}
            <AdminAction tone="down" onClick={() => admin.remove.mutate(post.id)}>Delete</AdminAction>
          </div>
        ) : null}
      </div>

      {/* A pasted link or an unspaced run of characters has nowhere to wrap, so it would otherwise
          stretch the card past the viewport. */}
      {post.title ? <h2 className="mb-1 break-words text-sm font-semibold text-fg">{post.title}</h2> : null}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">{post.body}</p>

      {post.streamUrl ? (
        <a
          href={post.streamUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-3 inline-flex h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg"
        >
          Watch the live
        </a>
      ) : null}

      {post.kind === 'poll' && post.options.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {post.options.map((o) => {
            const pct = post.totalVotes > 0 ? Math.round((o.votes / post.totalVotes) * 100) : 0;
            const mine = post.myVote === o.id;
            return (
              <button
                key={o.id}
                type="button"
                disabled={post.closed || vote.isPending}
                onClick={() => vote.mutate({ postId: post.id, optionId: o.id })}
                className={cn(
                  'relative flex min-h-11 w-full items-center overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed',
                  mine ? 'border-accent text-fg' : 'border-border text-fg/90 hover:border-accent/50',
                )}
              >
                {/* The bar is the result, drawn behind the label rather than beside it, so a long
                    option name never squeezes the number off the row. */}
                <span className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${pct}%` }} aria-hidden="true" />
                <span className="relative flex w-full min-w-0 items-center gap-2">
                  {/* The tick is a sibling of the label, not part of it: inside the truncating span a
                      long option name would shorten away the one mark that says how you voted. */}
                  {mine ? <span className="shrink-0" aria-hidden>✓</span> : null}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{pct}%</span>
                </span>
              </button>
            );
          })}
          <p className="pt-0.5 text-[11px] text-muted">
            {post.totalVotes} {post.totalVotes === 1 ? 'vote' : 'votes'}{post.closed ? ' · closed' : ''}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** The admin composer: a note, or a question with choices. */
function Composer() {
  const admin = useCommunityAdmin();
  const [kind, setKind] = useState<'post' | 'poll'>('post');
  const [body, setBody] = useState('');
  const [options, setOptions] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const send = () => {
    setErr(null);
    const opts = options.split('\n').map((s) => s.trim()).filter(Boolean);
    if (kind === 'poll' && opts.length < 2) { setErr('A question needs at least two choices.'); return; }
    admin.post.mutate(
      { kind, body: body.trim(), ...(kind === 'poll' ? { options: opts } : {}) },
      { onSuccess: () => { setBody(''); setOptions(''); }, onError: (e) => setErr(e instanceof Error ? e.message : 'Could not post.') },
    );
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      {/* Each toggle takes half the row on a phone so both are a full finger wide; from 360px up
          they shrink back to the width of their own label. */}
      <div className="mb-2 flex gap-1">
        {(['post', 'poll'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn('flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-xs font-semibold xs:flex-none',
              kind === k ? 'bg-accent text-accent-fg' : 'border border-border text-muted')}
          >
            {k === 'post' ? 'Announcement' : 'Question'}
          </button>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={kind === 'poll' ? 'Ask your question — e.g. Do we go live at 10am?' : 'Write to your players…'}
        /* A textarea carries an intrinsic `cols` width that beats a narrow parent, so it needs both
           block layout and a floor of zero before `w-full` can hold it inside the card. */
        className="block w-full min-w-0 resize-y rounded-lg border border-border bg-bg p-3 text-base text-fg outline-none focus:border-accent sm:text-sm"
      />

      {kind === 'poll' ? (
        <textarea
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          rows={3}
          placeholder={'One choice per line\n10am\n2pm\n8pm'}
          className="mt-2 block w-full min-w-0 resize-y rounded-lg border border-border bg-bg p-3 text-base text-fg outline-none focus:border-accent sm:text-sm"
        />
      ) : null}

      {err ? <p className="mt-2 text-xs text-down">{err}</p> : null}

      <button
        type="button"
        disabled={!body.trim() || admin.post.isPending}
        onClick={send}
        className="mt-2 h-11 w-full rounded-lg bg-accent text-sm font-semibold text-accent-fg disabled:opacity-50"
      >
        {admin.post.isPending ? 'Posting…' : kind === 'poll' ? 'Ask' : 'Post'}
      </button>
    </section>
  );
}

function AdminAction({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone?: 'down' }) {
  return (
    // The hit area is a finger, not the 11px label: the visual weight stays small, the target does not.
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center whitespace-nowrap rounded px-2 hover:bg-border/50',
        tone === 'down' ? 'text-down' : 'text-muted',
      )}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mx-auto max-w-2xl px-4 py-10 text-center text-sm text-muted">{children}</p>;
}
