/**
 * Referral / commission READ layer (instant-commission model, migration 0068).
 *
 * Powers the referral view for EVERY user (players + marketers) and the professional marketer
 * dashboard: the caller's referral code + link, headline earnings (total / 30d / by level /
 * player-referral), a paginated commission feed, and a per-referred-player breakdown with the
 * "deposited vs played (exhausted)" transparency the operator asked for. All reads are brand-scoped.
 */
import type { Querier } from "./wallet.js";
import { type Page, type PageQuery, clampLimit, decodeKeyset, encodeKeyset } from "./paging.js";

export interface ReferralInfo {
  code: string | null;
  primaryDomain: string | null;
  referralPath: string;          // /r/<code>
  referredCount: number;         // direct referrals
  downlineMarketers: number;     // direct referrals who are marketers
}
export interface CommissionEarnings {
  totalCents: number;
  last30dCents: number;
  byLevel: { l1: number; l2: number; l3: number };
  playerReferralCents: number;   // earnings from the 5% player-referral rate
  count: number;
}
export interface CommissionEvent {
  id: string; referredUsername: string; level: number; role: string; rate: number;
  depositCents: number; commissionCents: number; createdAtMs: number;
}
export interface ReferredPlayer {
  userId: string; username: string;
  depositsCents: number;         // real M-Pesa deposits brought
  playedCents: number;           // net loss (GGR) — how much of it they've "exhausted" by playing
  unplayedCents: number;         // deposits still sitting (not yet lost) — transparency
  commissionCents: number;       // what THIS beneficiary earned from this player
  lastActiveMs: number | null;
}

export interface ReferralRepository {
  info(userId: string, siteId: string): Promise<ReferralInfo>;
  earnings(userId: string, siteId: string): Promise<CommissionEarnings>;
  history(userId: string, siteId: string, q: PageQuery): Promise<Page<CommissionEvent>>;
  referred(userId: string, siteId: string): Promise<ReferredPlayer[]>;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const ms = (v: unknown): number => (v == null ? 0 : new Date(v as string).getTime());

export class PgReferralRepository implements ReferralRepository {
  constructor(private readonly q: Querier) {}

  async info(userId: string, siteId: string): Promise<ReferralInfo> {
    const r = await this.q.query(
      `select p.referral_code as code, s.primary_domain,
              (select count(*) from profiles c where c.referred_by = $1 and c.site_id = $2) as referred_count,
              (select count(*) from profiles c where c.referred_by = $1 and c.site_id = $2 and c.role = 'marketer') as downline_marketers
         from profiles p join sites s on s.id = p.site_id
        where p.id = $1`, [userId, siteId]);
    const x = r.rows[0] ?? {};
    const code: string | null = x.code ?? null;
    return {
      code, primaryDomain: x.primary_domain ?? null,
      referralPath: code ? `/r/${code}` : "",
      referredCount: n(x.referred_count), downlineMarketers: n(x.downline_marketers),
    };
  }

  async earnings(userId: string, siteId: string): Promise<CommissionEarnings> {
    const r = await this.q.query(
      `select coalesce(sum(commission_amount),0) total,
              coalesce(sum(commission_amount) filter (where created_at >= now() - interval '30 days'),0) last30,
              coalesce(sum(commission_amount) filter (where level = 1 and beneficiary_role = 'marketer'),0) l1,
              coalesce(sum(commission_amount) filter (where level = 2),0) l2,
              coalesce(sum(commission_amount) filter (where level = 3),0) l3,
              coalesce(sum(commission_amount) filter (where beneficiary_role = 'player'),0) player_ref,
              count(*) cnt
         from deposit_commissions where beneficiary_user = $1 and site_id = $2`, [userId, siteId]);
    const x = r.rows[0] ?? {};
    return {
      totalCents: n(x.total), last30dCents: n(x.last30),
      byLevel: { l1: n(x.l1), l2: n(x.l2), l3: n(x.l3) },
      playerReferralCents: n(x.player_ref), count: n(x.cnt),
    };
  }

  async history(userId: string, siteId: string, q: PageQuery): Promise<Page<CommissionEvent>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select dc.id, dc.level, dc.beneficiary_role as role, dc.rate, dc.deposit_amount, dc.commission_amount,
              dc.created_at, pr.username as referred_username
         from deposit_commissions dc join profiles pr on pr.id = dc.referred_user
        where dc.beneficiary_user = $1 and dc.site_id = $2
          and ($3::timestamptz is null or (dc.created_at, dc.id) < ($3::timestamptz, $4::bigint))
        order by dc.created_at desc, dc.id desc
        limit $5`,
      [userId, siteId, cur ? new Date(cur.tsMs).toISOString() : null, cur ? Number(cur.id) : null, limit + 1]);
    const rows: CommissionEvent[] = r.rows.map((x) => ({
      id: String(x.id), referredUsername: String(x.referred_username), level: n(x.level), role: String(x.role),
      rate: Number(x.rate), depositCents: n(x.deposit_amount), commissionCents: n(x.commission_amount), createdAtMs: ms(x.created_at),
    }));
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeKeyset(last.createdAtMs, last.id) : null };
  }

  async referred(userId: string, siteId: string): Promise<ReferredPlayer[]> {
    const r = await this.q.query(
      `select c.id as user_id, c.username,
              coalesce(dep.total,0) as deposits,
              coalesce(ggr.net,0)   as played,
              coalesce(comm.total,0) as commission,
              greatest(coalesce(dep.last_at,'epoch'::timestamptz), coalesce(ggr.last_at,'epoch'::timestamptz)) as last_active
         from profiles c
         left join lateral (select sum(amount) total, max(created_at) last_at from transactions t
                             where t.user_id = c.id and t.kind='deposit' and t.status='success') dep on true
         left join lateral (select greatest(0, sum(stake - payout)) net, max(settled_at) last_at from positions po
                             where po.user_id = c.id and po.status='settled') ggr on true
         left join lateral (select sum(commission_amount) total from deposit_commissions dc
                             where dc.referred_user = c.id and dc.beneficiary_user = $1) comm on true
        where c.referred_by = $1 and c.site_id = $2
        order by coalesce(dep.total,0) desc, c.username asc
        limit 200`, [userId, siteId]);
    return r.rows.map((x) => {
      const deposits = n(x.deposits), played = Math.min(n(x.played), deposits);
      return {
        userId: String(x.user_id), username: String(x.username),
        depositsCents: deposits, playedCents: played, unplayedCents: Math.max(0, deposits - played),
        commissionCents: n(x.commission),
        lastActiveMs: x.last_active && new Date(x.last_active).getTime() > 0 ? ms(x.last_active) : null,
      };
    });
  }
}

/** Test/dev stub: satisfies the interface with empty data (real behaviour is covered by DB e2e). */
export class InMemoryReferralRepository implements ReferralRepository {
  async info(): Promise<ReferralInfo> { return { code: null, primaryDomain: null, referralPath: "", referredCount: 0, downlineMarketers: 0 }; }
  async earnings(): Promise<CommissionEarnings> { return { totalCents: 0, last30dCents: 0, byLevel: { l1: 0, l2: 0, l3: 0 }, playerReferralCents: 0, count: 0 }; }
  async history(): Promise<Page<CommissionEvent>> { return { items: [], nextCursor: null }; }
  async referred(): Promise<ReferredPlayer[]> { return []; }
}
