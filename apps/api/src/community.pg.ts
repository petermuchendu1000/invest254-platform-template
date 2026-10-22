import { centsToKes } from "@invest254/shared/money";

/**
 * The per-brand community channel (migration 0192): operators post, players read and vote.
 *
 * A CHANNEL, not a group. There is no player composer in this module, deliberately — a brand's own
 * channel carrying an unmoderated player conversation is a support and compliance surface nobody
 * asked for, and players already have a voice in the trade screen's live chat (docs/54).
 */
export interface CommunityQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

export interface PollOption { id: string; label: string; votes: number }

export interface CommunityPost {
  id: string;
  kind: 'post' | 'poll' | 'live';
  title: string | null;
  body: string;
  streamUrl: string | null;
  pinned: boolean;
  closed: boolean;
  createdAt: string;
  author: string;
  options: PollOption[];
  /** The option THIS reader chose, so the client can show their own vote. */
  myVote: string | null;
  totalVotes: number;
}

export interface CommunityStore {
  list(siteId: string, viewerId: string | null, limit: number): Promise<CommunityPost[]>;
  post(siteId: string, authorId: string, input: { kind?: 'post' | 'poll'; title?: string | null; body: string; options?: string[]; pinned?: boolean }): Promise<CommunityPost>;
  vote(siteId: string, postId: string, userId: string, optionId: string): Promise<CommunityPost>;
  setClosed(siteId: string, postId: string, closed: boolean): Promise<void>;
  setPinned(siteId: string, postId: string, pinned: boolean): Promise<void>;
  remove(siteId: string, postId: string): Promise<void>;
  /** The automatic card a Start Live writes. Returns the post so the caller can broadcast it. */
  announceLive(siteId: string, authorId: string, streamUrl: string | null, brandName: string): Promise<CommunityPost>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * What a player is told when their brand goes live.
 *
 * Persuasive, and true. It names the brand, says what is happening, states the player's OWN balance
 * (a real number they can verify in the same app), and invites them in. What it deliberately does
 * NOT do: promise a win, imply the session is more likely to pay, invent a countdown, or claim
 * anyone else is winning right now. Those are the lines that turn a marketing message into a
 * misrepresentation, and on a real-money product in this market that is a regulatory problem long
 * before it is an ethical one.
 *
 * The text is built SERVER-SIDE from the player's own row, so a client cannot put a different
 * balance, or a different link, in front of someone.
 */
export function liveMessage(brandName: string, balanceCents: number, streamUrl: string | null): { title: string; body: string } {
  const bal = `KES ${centsToKes(Math.max(0, balanceCents)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const where = streamUrl ? ` Watch here: ${streamUrl}` : '';
  return {
    title: `${brandName} is live now`,
    body: balanceCents > 0
      ? `We are trading live right now. Your balance is ${bal} — come and trade along with us.${where}`
      : `We are trading live right now. Top up and trade along with us.${where}`,
  };
}

const POST_SELECT = `
  select p.id, p.kind, p.title, p.body, p.stream_url, p.pinned, p.closed_at, p.created_at,
         coalesce(a.username, 'Admin') as author,
         (select count(*) from public.community_poll_votes v where v.post_id = p.id) as total_votes,
         (select v.option_id from public.community_poll_votes v where v.post_id = p.id and v.user_id = $2) as my_vote,
         coalesce((
           select json_agg(json_build_object(
                    'id', o.id, 'label', o.label,
                    'votes', (select count(*) from public.community_poll_votes v where v.option_id = o.id)
                  ) order by o.position)
             from public.community_poll_options o where o.post_id = p.id
         ), '[]'::json) as options
    from public.community_posts p
    left join public.profiles a on a.id = p.author_id
`;

function mapPost(x: Record<string, unknown>): CommunityPost {
  const raw = x.options;
  const options = (Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : []) as PollOption[];
  return {
    id: String(x.id),
    kind: x.kind === 'poll' ? 'poll' : x.kind === 'live' ? 'live' : 'post',
    title: (x.title as string | null) ?? null,
    body: String(x.body ?? ''),
    streamUrl: (x.stream_url as string | null) ?? null,
    pinned: x.pinned === true,
    closed: x.closed_at != null,
    createdAt: iso(x.created_at),
    author: String(x.author ?? 'Admin'),
    options: options.map((o) => ({ id: String(o.id), label: String(o.label), votes: Number(o.votes ?? 0) })),
    myVote: (x.my_vote as string | null) ?? null,
    totalVotes: Number(x.total_votes ?? 0),
  };
}

export function makePgCommunity(q: CommunityQuerier): CommunityStore {
  async function one(siteId: string, postId: string, viewerId: string | null): Promise<CommunityPost> {
    const r = await q.query(`${POST_SELECT} where p.site_id = $1 and p.id = $3`, [siteId, viewerId, postId]);
    if (!r.rows.length) throw new Error('POST_NOT_FOUND');
    return mapPost(r.rows[0]!);
  }

  return {
    async list(siteId, viewerId, limit) {
      const r = await q.query(
        `${POST_SELECT} where p.site_id = $1 order by p.pinned desc, p.created_at desc limit $3`,
        [siteId, viewerId, limit],
      );
      return r.rows.map(mapPost);
    },

    async post(siteId, authorId, input) {
      const kind = input.kind === 'poll' ? 'poll' : 'post';
      const opts = (input.options ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
      if (kind === 'poll' && opts.length < 2) throw new Error('POLL_NEEDS_OPTIONS');

      const ins = await q.query(
        `insert into public.community_posts (site_id, author_id, kind, title, body, pinned)
         values ($1, $2, $3, nullif(btrim($4), ''), $5, $6) returning id`,
        [siteId, authorId, kind, input.title ?? '', String(input.body ?? '').slice(0, 4000), input.pinned === true],
      );
      const id = String(ins.rows[0]!.id);
      for (const [i, label] of opts.entries()) {
        await q.query(
          `insert into public.community_poll_options (post_id, label, position) values ($1, $2, $3)`,
          [id, label.slice(0, 120), i],
        );
      }
      return one(siteId, id, null);
    },

    async vote(siteId, postId, userId, optionId) {
      /**
       * Refuse in SQL rather than in three round trips: the insert only lands if the option really
       * belongs to this post, the post really belongs to this brand, and the poll is still open.
       * A closed poll or a smuggled option id from another brand's post simply matches nothing.
       */
      const r = await q.query(
        `insert into public.community_poll_votes (post_id, option_id, user_id)
         select o.post_id, o.id, $3
           from public.community_poll_options o
           join public.community_posts p on p.id = o.post_id
          where o.id = $4 and p.id = $2 and p.site_id = $1 and p.kind = 'poll' and p.closed_at is null
         on conflict (post_id, user_id) do update set option_id = excluded.option_id, created_at = now()
         returning post_id`,
        [siteId, postId, userId, optionId],
      );
      if (!r.rows.length) throw new Error('VOTE_REFUSED');
      return one(siteId, postId, userId);
    },

    async setClosed(siteId, postId, closed) {
      await q.query(
        `update public.community_posts set closed_at = ${closed ? 'now()' : 'null'}, updated_at = now()
          where site_id = $1 and id = $2`,
        [siteId, postId],
      );
    },

    async setPinned(siteId, postId, pinned) {
      await q.query(
        `update public.community_posts set pinned = $3, updated_at = now() where site_id = $1 and id = $2`,
        [siteId, postId, pinned],
      );
    },

    async remove(siteId, postId) {
      await q.query(`delete from public.community_posts where site_id = $1 and id = $2`, [siteId, postId]);
    },

    async announceLive(siteId, authorId, streamUrl, brandName) {
      const ins = await q.query(
        `insert into public.community_posts (site_id, author_id, kind, title, body, stream_url, pinned)
         values ($1, $2, 'live', $3, $4, nullif(btrim($5), ''), true) returning id`,
        [
          siteId, authorId,
          `${brandName} is live now`,
          streamUrl ? 'We are trading live. Tap to watch and trade along.' : 'We are trading live. Come and trade along.',
          streamUrl ?? '',
        ],
      );
      // Only the newest live card stays pinned, so the channel does not accumulate stale "we are
      // live" banners at the top.
      await q.query(
        `update public.community_posts set pinned = false
          where site_id = $1 and kind = 'live' and id <> $2`,
        [siteId, String(ins.rows[0]!.id)],
      );
      return one(siteId, String(ins.rows[0]!.id), null);
    },
  };
}
