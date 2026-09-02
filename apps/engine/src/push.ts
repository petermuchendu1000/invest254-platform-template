import type { Cents } from "@invest254/shared";
import type { Querier } from "./wallet.js";

/**
 * Web Push (W3C Push API + VAPID) for real-time admin alerts — Issue 1.
 *
 * When a player creates a PENDING withdrawal (the case that needs a human decision), the API fires
 * PaymentEvents.onWithdrawalRequested, which the server routes into PushService.notifyWithdrawalRequested.
 * That fans the event out to every opted-in admin device as an OS/browser push notification carrying
 * inline "Approve" / "Reject" action buttons — so an admin sees the request the instant it happens,
 * without logging in to poll the queue.
 *
 * This module is transport-agnostic: PushService depends only on the WebPushTransport interface, so
 * the concrete `web-push`/VAPID sender lives in apps/api (keeping @invest254/engine dependency-free)
 * and tests inject a capturing fake. Delivery failures never block the withdrawal — the caller wraps
 * the call fire-and-forget and PushService itself swallows per-subscription errors, pruning the ones
 * the push service reports as permanently gone (HTTP 404/410).
 */

/** A stored browser push subscription (mirrors the push_subscriptions table, migration 0107). */
export interface PushSubscriptionRow {
  id?: number;
  userId: string;
  siteId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/** The W3C PushSubscription JSON a browser produces (what the client POSTs to /admin/push/subscribe). */
export interface WebPushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Result of one push delivery attempt. `gone` = 404/410: the endpoint is dead and must be pruned. */
export interface PushSendResult {
  ok: boolean;
  statusCode?: number | undefined;
  gone?: boolean | undefined;
  error?: string | undefined;
}

/** Abstracts the VAPID sender so the engine stays dependency-free and tests can capture sends. */
export interface WebPushTransport {
  /** The VAPID public key (base64url) the client needs to create a subscription. */
  publicKey(): string | null;
  send(sub: PushSubscriptionRow, payload: string): Promise<PushSendResult>;
}

/** Persistence for admin push subscriptions. */
export interface PushSubscriptionRepository {
  /**
   * Upsert a subscription (keyed by endpoint). Re-subscribing the same browser refreshes its keys
   * and last_seen_at rather than creating a duplicate row.
   */
  upsert(sub: PushSubscriptionRow): Promise<void>;
  /** Remove a subscription by endpoint (client unsubscribed / permission revoked). Returns removed count. */
  removeByEndpoint(endpoint: string): Promise<number>;
  /**
   * Every admin/superadmin device that should be alerted for a withdrawal on `siteId`:
   * site-scoped admins whose site_id = siteId, PLUS platform admins (site_id IS NULL). When siteId
   * is undefined (single-tenant / unknown brand) every admin subscription is returned.
   */
  listForWithdrawalSite(siteId: string | undefined | null): Promise<PushSubscriptionRow[]>;
}

/** The payload shape delivered to the service worker; JSON-serialized as the push body. */
export interface WithdrawalPushPayload {
  type: "withdrawal_requested";
  txId: string;
  amountCents: Cents;
  userId: string;
  phone: string;
  siteId: string | null;
  title: string;
  body: string;
  /** Inline notification action buttons rendered by the service worker. */
  actions: Array<{ action: "approve" | "reject" | "view"; title: string }>;
  /** Deep-link opened when the body (not an action) is tapped. */
  url: string;
  ts: number;
}

export interface WithdrawalRequestedEvent {
  txId: string;
  userId: string;
  amountCents: Cents;
  phone: string;
  siteId?: string | undefined;
}

/** Optional identity resolver so the notification can name the requester instead of a raw id. */
export type HandleResolver = (userId: string) => Promise<string | null> | string | null;

function formatKes(cents: Cents): string {
  // Cents are integer KES*100. Render as "KES 1,234.50" (drop the .00 for whole amounts).
  const kes = cents / 100;
  const s = Number.isInteger(kes) ? kes.toLocaleString("en-KE") : kes.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `KES ${s}`;
}

export class PushService {
  constructor(
    private readonly repo: PushSubscriptionRepository,
    private readonly transport: WebPushTransport,
    private readonly opts: { resolveHandle?: HandleResolver; appBaseUrl?: string } = {},
  ) {}

  /** VAPID public key for the client (null when push is not configured). */
  publicKey(): string | null {
    return this.transport.publicKey();
  }

  upsert(sub: PushSubscriptionRow): Promise<void> {
    return this.repo.upsert(sub);
  }

  removeByEndpoint(endpoint: string): Promise<number> {
    return this.repo.removeByEndpoint(endpoint);
  }

  /**
   * Build the withdrawal-requested payload (pure — unit-testable without a transport). Exposed so
   * both the sender and tests share one source of truth for the notification shape + action buttons.
   */
  async buildWithdrawalPayload(e: WithdrawalRequestedEvent): Promise<WithdrawalPushPayload> {
    let who = "A player";
    try {
      const h = await this.opts.resolveHandle?.(e.userId);
      if (h) who = h;
    } catch { /* fail-open: fall back to the generic label */ }
    const amount = formatKes(e.amountCents);
    const base = (this.opts.appBaseUrl ?? "").replace(/\/+$/, "");
    return {
      type: "withdrawal_requested",
      txId: e.txId,
      amountCents: e.amountCents,
      userId: e.userId,
      phone: e.phone,
      siteId: e.siteId ?? null,
      title: `Withdrawal request: ${amount}`,
      body: `${who} requested a withdrawal of ${amount} to ${e.phone}. Approve or reject?`,
      actions: [
        { action: "approve", title: "Approve" },
        { action: "reject", title: "Reject" },
      ],
      url: `${base}/admin/withdrawals?highlight=${encodeURIComponent(e.txId)}`,
      ts: Date.now(),
    };
  }

  /**
   * Fan a pending-withdrawal event out to every matching admin device. Never throws: per-subscription
   * failures are isolated, and endpoints the push service reports as gone (404/410) are pruned so the
   * table self-heals. Returns a small summary for logging/tests.
   */
  async notifyWithdrawalRequested(e: WithdrawalRequestedEvent): Promise<{ sent: number; failed: number; pruned: number; recipients: number }> {
    let subs: PushSubscriptionRow[];
    try {
      subs = await this.repo.listForWithdrawalSite(e.siteId);
    } catch {
      return { sent: 0, failed: 0, pruned: 0, recipients: 0 };
    }
    if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0, recipients: 0 };

    const payload = JSON.stringify(await this.buildWithdrawalPayload(e));
    let sent = 0, failed = 0, pruned = 0;
    await Promise.all(subs.map(async (sub) => {
      let res: PushSendResult;
      try {
        res = await this.transport.send(sub, payload);
      } catch (err) {
        failed++;
        return;
      }
      if (res.ok) { sent++; return; }
      failed++;
      if (res.gone) {
        try { await this.repo.removeByEndpoint(sub.endpoint); pruned++; } catch { /* ignore prune error */ }
      }
    }));
    return { sent, failed, pruned, recipients: subs.length };
  }
}

/** In-memory repo for API/engine tests (no DB). */
export class InMemoryPushSubscriptionRepository implements PushSubscriptionRepository {
  private rows: PushSubscriptionRow[] = [];
  /** Test seam: seed an admin device. */
  _seed(sub: PushSubscriptionRow): void {
    this.upsertSync(sub);
  }
  private upsertSync(sub: PushSubscriptionRow): void {
    const i = this.rows.findIndex((r) => r.endpoint === sub.endpoint);
    if (i >= 0) this.rows[i] = { ...this.rows[i], ...sub };
    else this.rows.push({ ...sub });
  }
  async upsert(sub: PushSubscriptionRow): Promise<void> { this.upsertSync(sub); }
  async removeByEndpoint(endpoint: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.endpoint !== endpoint);
    return before - this.rows.length;
  }
  async listForWithdrawalSite(siteId: string | undefined | null): Promise<PushSubscriptionRow[]> {
    if (siteId === undefined || siteId === null) return [...this.rows];
    return this.rows.filter((r) => r.siteId === null || r.siteId === siteId);
  }
  /** Test seam: current rows. */
  _all(): PushSubscriptionRow[] { return [...this.rows]; }
}

/** Postgres-backed repo (service role) mirroring migration 0107. */
export class PgPushSubscriptionRepository implements PushSubscriptionRepository {
  constructor(private readonly q: Querier) {}

  async upsert(sub: PushSubscriptionRow): Promise<void> {
    await this.q.query(
      `insert into public.push_subscriptions (user_id, site_id, endpoint, p256dh, auth, user_agent, last_seen_at)
         values ($1, $2, $3, $4, $5, $6, now())
       on conflict (endpoint) do update
         set user_id = excluded.user_id,
             site_id = excluded.site_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             user_agent = excluded.user_agent,
             failure_count = 0,
             last_seen_at = now()`,
      [sub.userId, sub.siteId, sub.endpoint, sub.p256dh, sub.auth, sub.userAgent ?? null],
    );
  }

  async removeByEndpoint(endpoint: string): Promise<number> {
    const r = await this.q.query("delete from public.push_subscriptions where endpoint = $1", [endpoint]);
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  async listForWithdrawalSite(siteId: string | undefined | null): Promise<PushSubscriptionRow[]> {
    // Only admins/superadmins receive withdrawal alerts; join profiles to enforce the role at read
    // time so a demoted admin's stale subscription can never be alerted. Platform admins (site_id
    // null) get every brand; a site-scoped admin gets only its own brand.
    const sql = `
      select ps.id, ps.user_id, ps.site_id, ps.endpoint, ps.p256dh, ps.auth, ps.user_agent
        from public.push_subscriptions ps
        join public.profiles p on p.id = ps.user_id
       where p.role in ('admin','superadmin')
         and ($1::uuid is null or ps.site_id is null or ps.site_id = $1::uuid)`;
    const r = await this.q.query(sql, [siteId ?? null]);
    return r.rows.map((row: any) => ({
      id: Number(row.id),
      userId: String(row.user_id),
      siteId: row.site_id === null ? null : String(row.site_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      userAgent: row.user_agent === null ? null : String(row.user_agent),
    }));
  }
}
