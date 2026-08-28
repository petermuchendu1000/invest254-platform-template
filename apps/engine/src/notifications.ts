import type { Querier } from "./wallet.js";

/**
 * User notifications: server-authoritative, per-user sticky banners the admin (or the system)
 * raises for a specific player — "account suspended", "system failure", "bonus KES X added", etc.
 *
 * Two lifecycles:
 *  - dismissible (default): the player can clear it with the X (sets `dismissedAtMs`).
 *  - blocking (dismissible=false): the player CANNOT clear it (e.g. account suspension and other
 *    activity-limiting states). It stays until an admin/system RESOLVES it (sets `resolvedAtMs`),
 *    typically when the underlying condition is lifted (e.g. the account is reactivated).
 *
 * "Active" = neither dismissed nor resolved. Only active rows are shown to the player.
 * The engine/API access this as the RLS-bypassing service role, so plain INSERT/SELECT/UPDATE
 * suffice; a defense-in-depth self-select RLS policy also exists (migration 0031).
 */
export type NotificationLevel = "info" | "success" | "warning" | "error";

/** A saved system-notification template (migration 0106). */
export interface NotificationTemplate {
  key: string; level: NotificationLevel; title: string; body: string;
  dismissible: boolean; category: string; resolvesCategory: string | null;
  defaultAudience: BroadcastAudience; description: string | null;
}
/**
 * Audience filter for a broadcast. Keys mirror the SQL jsonb spec exactly so the value passes
 * straight to fn_notification_audience. All fields optional; {} = all active people-facing users.
 * Setting affected_within_hours targets ONLY users with a FAILED payment of affected_kind in the
 * window — the "select all affected" audience.
 */
export interface BroadcastAudience {
  status?: string;
  roles?: string[];
  sites?: string[];
  affected_within_hours?: number;
  affected_kind?: "deposit" | "withdrawal";
}

export interface NotificationRow {
  id: number;
  userId: string;
  level: NotificationLevel;
  title: string;
  body: string;
  dismissible: boolean;
  category: string | null;
  createdBy: string | null;
  createdAtMs: number;
  dismissedAtMs: number | null;
  resolvedAtMs: number | null;
}

export interface CreateNotification {
  userId: string;
  level?: NotificationLevel;
  title: string;
  body?: string;
  dismissible?: boolean;
  category?: string | null;
  createdBy?: string | null;
}

const LEVELS: ReadonlySet<string> = new Set(["info", "success", "warning", "error"]);
const MAX_TITLE = 120;
const MAX_BODY = 1000;

export interface NotificationRepository {
  insert(n: Required<Pick<CreateNotification, "userId" | "title">> & {
    level: NotificationLevel; body: string; dismissible: boolean; category: string | null; createdBy: string | null;
  }): Promise<NotificationRow>;
  listActiveForUser(userId: string): Promise<NotificationRow[]>;   // active only, newest first
  listForUser(userId: string, includeInactive: boolean, limit: number): Promise<NotificationRow[]>;
  dismiss(userId: string, id: number): Promise<boolean>;           // only dismissible + active
  resolve(id: number): Promise<boolean>;                           // admin/system clears (any)
  resolveByCategory(userId: string, category: string): Promise<number>;
  // ── Broadcast engine (migration 0106) ──
  listTemplates(): Promise<NotificationTemplate[]>;
  audienceCount(audience: BroadcastAudience): Promise<number>;
  broadcast(actorId: string, actorRole: string, templateKey: string, audience: BroadcastAudience | null): Promise<number>;
  resolveCategory(actorId: string, actorRole: string, category: string): Promise<number>;
}

/**
 * NotificationService: validation + the small amount of policy that sits above the repo
 * (a blocking notification cannot be dismissed by the player; resolve is admin/system only).
 */
export class NotificationService {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async create(input: CreateNotification): Promise<NotificationRow> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("TITLE_REQUIRED");
    if (title.length > MAX_TITLE) throw new Error("TITLE_TOO_LONG");
    const body = String(input.body ?? "").slice(0, MAX_BODY);
    const level: NotificationLevel = (input.level && LEVELS.has(input.level) ? input.level : "info") as NotificationLevel;
    const category = input.category ? String(input.category).slice(0, 64) : null;
    return this.repo.insert({
      userId: input.userId,
      title,
      body,
      level,
      // A blocking notification is opt-in; default is dismissible.
      dismissible: input.dismissible !== false ? input.dismissible !== undefined ? input.dismissible : true : false,
      category,
      createdBy: input.createdBy ?? null,
    });
  }

  listActive(userId: string): Promise<NotificationRow[]> { return this.repo.listActiveForUser(userId); }
  adminList(userId: string, includeInactive = true, limit = 100): Promise<NotificationRow[]> {
    return this.repo.listForUser(userId, includeInactive, Math.min(Math.max(1, limit), 200));
  }
  /** Player dismiss: the repo enforces that only a dismissible, active row is cleared. */
  dismiss(userId: string, id: number): Promise<boolean> { return this.repo.dismiss(userId, id); }
  /** Admin/system resolve: clears a blocking (or any) notification. */
  resolve(id: number): Promise<boolean> { return this.repo.resolve(id); }
  resolveByCategory(userId: string, category: string): Promise<number> { return this.repo.resolveByCategory(userId, category); }
  // ── Broadcast engine (migration 0106) ──
  listTemplates(): Promise<NotificationTemplate[]> { return this.repo.listTemplates(); }
  audienceCount(audience: BroadcastAudience): Promise<number> { return this.repo.audienceCount(audience ?? {}); }
  broadcast(actorId: string, actorRole: string, templateKey: string, audience: BroadcastAudience | null): Promise<number> {
    const key = String(templateKey ?? "").trim();
    if (!key) throw new Error("TEMPLATE_KEY_REQUIRED");
    return this.repo.broadcast(actorId, actorRole, key, audience ?? null);
  }
  resolveCategory(actorId: string, actorRole: string, category: string): Promise<number> {
    const cat = String(category ?? "").trim();
    if (!cat) throw new Error("CATEGORY_REQUIRED");
    return this.repo.resolveCategory(actorId, actorRole, cat);
  }
}

// ───────────────────────────── In-memory (tests/dev) ─────────────────────────────
export class InMemoryNotificationRepository implements NotificationRepository {
  private rows: NotificationRow[] = [];
  private id = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  async insert(n: {
    userId: string; title: string; level: NotificationLevel; body: string; dismissible: boolean; category: string | null; createdBy: string | null;
  }): Promise<NotificationRow> {
    const row: NotificationRow = {
      id: ++this.id, userId: n.userId, level: n.level, title: n.title, body: n.body,
      dismissible: n.dismissible, category: n.category, createdBy: n.createdBy,
      createdAtMs: this.now(), dismissedAtMs: null, resolvedAtMs: null,
    };
    this.rows.push(row);
    return { ...row };
  }
  async listActiveForUser(userId: string): Promise<NotificationRow[]> {
    return this.rows
      .filter((r) => r.userId === userId && r.dismissedAtMs === null && r.resolvedAtMs === null)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((r) => ({ ...r }));
  }
  async listForUser(userId: string, includeInactive: boolean, limit: number): Promise<NotificationRow[]> {
    return this.rows
      .filter((r) => r.userId === userId && (includeInactive || (r.dismissedAtMs === null && r.resolvedAtMs === null)))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async dismiss(userId: string, id: number): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id && x.userId === userId);
    if (!r || !r.dismissible || r.dismissedAtMs !== null || r.resolvedAtMs !== null) return false;
    r.dismissedAtMs = this.now();
    return true;
  }
  async resolve(id: number): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.resolvedAtMs !== null) return false;
    r.resolvedAtMs = this.now();
    return true;
  }
  async resolveByCategory(userId: string, category: string): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.userId === userId && r.category === category && r.resolvedAtMs === null) { r.resolvedAtMs = this.now(); n++; }
    }
    return n;
  }
  // ── Broadcast engine (migration 0106): in-memory stubs (DB-backed in Pg; RPCs are e2e-tested) ──
  async listTemplates(): Promise<NotificationTemplate[]> { return []; }
  async audienceCount(_audience: BroadcastAudience): Promise<number> { return 0; }
  async broadcast(_actorId: string, _actorRole: string, _templateKey: string, _audience: BroadcastAudience | null): Promise<number> { return 0; }
  async resolveCategory(_actorId: string, _actorRole: string, _category: string): Promise<number> { return 0; }
}

// ───────────────────────────── Postgres ─────────────────────────────
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const toMsOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : toMs(v));

function mapRow(x: any): NotificationRow {
  return {
    id: Number(x.id), userId: String(x.user_id), level: String(x.level) as NotificationLevel,
    title: String(x.title), body: String(x.body ?? ""), dismissible: Boolean(x.dismissible),
    category: x.category == null ? null : String(x.category),
    createdBy: x.created_by == null ? null : String(x.created_by),
    createdAtMs: toMs(x.created_at), dismissedAtMs: toMsOrNull(x.dismissed_at), resolvedAtMs: toMsOrNull(x.resolved_at),
  };
}

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly q: Querier) {}

  async insert(n: {
    userId: string; title: string; level: NotificationLevel; body: string; dismissible: boolean; category: string | null; createdBy: string | null;
  }): Promise<NotificationRow> {
    const r = await this.q.query(
      `insert into user_notifications(user_id, level, title, body, dismissible, category, created_by)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id, user_id, level, title, body, dismissible, category, created_by, created_at, dismissed_at, resolved_at`,
      [n.userId, n.level, n.title, n.body, n.dismissible, n.category, n.createdBy]);
    return mapRow(r.rows[0]);
  }
  async listActiveForUser(userId: string): Promise<NotificationRow[]> {
    const r = await this.q.query(
      `select id, user_id, level, title, body, dismissible, category, created_by, created_at, dismissed_at, resolved_at
         from user_notifications
        where user_id = $1 and dismissed_at is null and resolved_at is null
        order by created_at desc, id desc`, [userId]);
    return r.rows.map(mapRow);
  }
  async listForUser(userId: string, includeInactive: boolean, limit: number): Promise<NotificationRow[]> {
    const r = await this.q.query(
      `select id, user_id, level, title, body, dismissible, category, created_by, created_at, dismissed_at, resolved_at
         from user_notifications
        where user_id = $1 and ($2::boolean or (dismissed_at is null and resolved_at is null))
        order by created_at desc, id desc
        limit $3`, [userId, includeInactive, limit]);
    return r.rows.map(mapRow);
  }
  async dismiss(userId: string, id: number): Promise<boolean> {
    const r = await this.q.query(
      `update user_notifications set dismissed_at = now()
        where id = $1 and user_id = $2 and dismissible = true and dismissed_at is null and resolved_at is null
        returning id`, [id, userId]);
    return r.rows.length > 0;
  }
  async resolve(id: number): Promise<boolean> {
    const r = await this.q.query(
      `update user_notifications set resolved_at = now() where id = $1 and resolved_at is null returning id`, [id]);
    return r.rows.length > 0;
  }
  async resolveByCategory(userId: string, category: string): Promise<number> {
    const r = await this.q.query(
      `update user_notifications set resolved_at = now()
        where user_id = $1 and category = $2 and resolved_at is null returning id`, [userId, category]);
    return r.rows.length;
  }
  // ── Broadcast engine (migration 0106): thin wrappers over the SQL functions ──
  async listTemplates(): Promise<NotificationTemplate[]> {
    const r = await this.q.query(
      `select key, level, title, body, dismissible, category, resolves_category, default_audience, description
         from notification_templates where active order by key`, []);
    return r.rows.map((x: any) => ({
      key: String(x.key), level: String(x.level) as NotificationLevel, title: String(x.title),
      body: String(x.body ?? ""), dismissible: Boolean(x.dismissible), category: String(x.category),
      resolvesCategory: x.resolves_category == null ? null : String(x.resolves_category),
      defaultAudience: (x.default_audience ?? {}) as BroadcastAudience,
      description: x.description == null ? null : String(x.description),
    }));
  }
  async audienceCount(audience: BroadcastAudience): Promise<number> {
    const r = await this.q.query(`select fn_notification_audience_count($1::jsonb) as n`, [JSON.stringify(audience ?? {})]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async broadcast(actorId: string, actorRole: string, templateKey: string, audience: BroadcastAudience | null): Promise<number> {
    const r = await this.q.query(
      `select fn_broadcast_notification($1, $2, $3, $4::jsonb) as n`,
      [actorId, actorRole, templateKey, audience == null ? null : JSON.stringify(audience)]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async resolveCategory(actorId: string, actorRole: string, category: string): Promise<number> {
    const r = await this.q.query(`select fn_resolve_notifications_by_category($1, $2, $3) as n`, [actorId, actorRole, category]);
    return Number(r.rows[0]?.n ?? 0);
  }
}
