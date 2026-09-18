import { randomUUID } from "node:crypto";
import type { Querier } from "./wallet.js";

/**
 * Internal escalation ticketing (Issue 2). Mutations go through the SECURITY DEFINER fn_ticket_*
 * RPCs (0139) which enforce urgency SLAs, platform scope, escalation logging and notifications.
 * Reads (list/get) are scoped here the same way: system=all, platform_admin=own platform, site
 * admin=own tickets.
 */
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const ms = (v: unknown): number | null => (v == null ? null : new Date(String(v)).getTime());

export interface Ticket {
  id: string; platformId: string; siteId: string | null; createdBy: string; createdByRole: string;
  subject: string; body: string; urgency: string; status: string; escalationLevel: number;
  assigneeRole: string; slaDueAtMs: number | null; firstResponseAtMs: number | null;
  resolvedAtMs: number | null; resolvedBy: string | null; closedAtMs: number | null;
  createdAtMs: number; updatedAtMs: number;
}
export interface TicketComment { id: number; ticketId: string; authorId: string; authorRole: string; body: string; createdAtMs: number; }
export interface TicketEscalation { id: number; ticketId: string; fromLevel: number; toLevel: number; fromRole: string | null; toRole: string | null; reason: string; note: string | null; actorId: string | null; actorRole: string | null; createdAtMs: number; }
export interface TicketDetail { ticket: Ticket; comments: TicketComment[]; escalations: TicketEscalation[]; }
export interface TicketListOpts { status?: string | undefined; urgency?: string | undefined; limit?: number | undefined; }

function mapTicket(x: Record<string, unknown>): Ticket {
  return { id: String(x.id), platformId: String(x.platform_id), siteId: x.site_id == null ? null : String(x.site_id),
    createdBy: String(x.created_by), createdByRole: String(x.created_by_role), subject: String(x.subject),
    body: String(x.body), urgency: String(x.urgency), status: String(x.status), escalationLevel: num(x.escalation_level),
    assigneeRole: String(x.assignee_role), slaDueAtMs: ms(x.sla_due_at), firstResponseAtMs: ms(x.first_response_at),
    resolvedAtMs: ms(x.resolved_at), resolvedBy: x.resolved_by == null ? null : String(x.resolved_by),
    closedAtMs: ms(x.closed_at), createdAtMs: ms(x.created_at)!, updatedAtMs: ms(x.updated_at)! };
}

export interface TicketRepository {
  create(actorId: string, actorRole: string, platformId: string | null, siteId: string | null, subject: string, body: string, urgency: string): Promise<Ticket>;
  list(actorId: string, actorRole: string, opts: TicketListOpts): Promise<Ticket[]>;
  get(actorId: string, actorRole: string, id: string): Promise<TicketDetail>;
  addComment(actorId: string, actorRole: string, id: string, body: string): Promise<TicketComment>;
  setStatus(actorId: string, actorRole: string, id: string, status: string, note: string | null): Promise<Ticket>;
  escalate(actorId: string, actorRole: string, id: string, note: string | null): Promise<Ticket>;
  autoEscalate(): Promise<number>;
}

export class PgTicketRepository implements TicketRepository {
  constructor(private readonly q: Querier) {}
  private scopeSql(actorRole: string): { where: string; arg: boolean } {
    if (actorRole === "platform_superadmin") return { where: "true", arg: false };
    if (actorRole === "platform_admin") return { where: "t.platform_id = (select platform_id from profiles where id = $1)", arg: true };
    if (actorRole === "admin") return { where: "t.created_by = $1", arg: true };
    return { where: "false", arg: false };
  }
  async create(a: string, r: string, p: string | null, s: string | null, subject: string, body: string, urgency: string): Promise<Ticket> {
    const res = await this.q.query("select * from fn_ticket_create($1,$2,$3,$4,$5,$6,$7)", [a, r, p, s, subject, body, urgency]);
    return mapTicket(res.rows[0] as Record<string, unknown>);
  }
  async list(a: string, r: string, opts: TicketListOpts): Promise<Ticket[]> {
    const sc = this.scopeSql(r); const args: unknown[] = sc.arg ? [a] : [];
    let sql = `select t.* from tickets t where ${sc.where}`;
    if (opts.status) { args.push(opts.status); sql += ` and t.status = $${args.length}`; }
    if (opts.urgency) { args.push(opts.urgency); sql += ` and t.urgency = $${args.length}`; }
    args.push(Math.min(200, Math.max(1, opts.limit ?? 50))); sql += ` order by t.created_at desc limit $${args.length}`;
    const res = await this.q.query(sql, args);
    return res.rows.map((x: Record<string, unknown>) => mapTicket(x));
  }
  async get(a: string, r: string, id: string): Promise<TicketDetail> {
    const sc = this.scopeSql(r); const args: unknown[] = sc.arg ? [a, id] : [id];
    const idParam = sc.arg ? "$2" : "$1";
    const tr = await this.q.query(`select t.* from tickets t where t.id = ${idParam} and ${sc.where}`, args);
    if (!tr.rows.length) throw new Error("TICKET_NOT_FOUND_OR_FORBIDDEN");
    const cr = await this.q.query("select * from ticket_comments where ticket_id=$1 order by created_at asc", [id]);
    const er = await this.q.query("select * from ticket_escalations where ticket_id=$1 order by created_at asc", [id]);
    return {
      ticket: mapTicket(tr.rows[0] as Record<string, unknown>),
      comments: cr.rows.map((x: Record<string, unknown>) => ({ id: num(x.id), ticketId: String(x.ticket_id), authorId: String(x.author_id), authorRole: String(x.author_role), body: String(x.body), createdAtMs: ms(x.created_at)! })),
      escalations: er.rows.map((x: Record<string, unknown>) => ({ id: num(x.id), ticketId: String(x.ticket_id), fromLevel: num(x.from_level), toLevel: num(x.to_level), fromRole: x.from_role == null ? null : String(x.from_role), toRole: x.to_role == null ? null : String(x.to_role), reason: String(x.reason), note: x.note == null ? null : String(x.note), actorId: x.actor_id == null ? null : String(x.actor_id), actorRole: x.actor_role == null ? null : String(x.actor_role), createdAtMs: ms(x.created_at)! })),
    };
  }
  async addComment(a: string, r: string, id: string, body: string): Promise<TicketComment> {
    const res = await this.q.query("select * from fn_ticket_add_comment($1,$2,$3,$4)", [a, r, id, body]);
    const x = res.rows[0] as Record<string, unknown>;
    return { id: num(x.id), ticketId: String(x.ticket_id), authorId: String(x.author_id), authorRole: String(x.author_role), body: String(x.body), createdAtMs: ms(x.created_at)! };
  }
  async setStatus(a: string, r: string, id: string, status: string, note: string | null): Promise<Ticket> {
    const res = await this.q.query("select * from fn_ticket_set_status($1,$2,$3,$4,$5)", [a, r, id, status, note]);
    return mapTicket(res.rows[0] as Record<string, unknown>);
  }
  async escalate(a: string, r: string, id: string, note: string | null): Promise<Ticket> {
    const res = await this.q.query("select * from fn_ticket_escalate($1,$2,$3,$4)", [a, r, id, note]);
    return mapTicket(res.rows[0] as Record<string, unknown>);
  }
  async autoEscalate(): Promise<number> {
    const res = await this.q.query("select fn_ticket_auto_escalate() as n", []);
    return num(res.rows[0].n);
  }
}

/** In-memory tickets for API tests: models scope (system/platform/creator) + create/comment/status/
 *  escalate. The urgency SLA + auto-escalation timing are proven against Postgres in the DB e2e;
 *  here platform membership is supplied via setActorPlatform() (tests wire it). */
export class InMemoryTicketRepository implements TicketRepository {
  private readonly tickets = new Map<string, Ticket>();
  private readonly comments: TicketComment[] = [];
  private readonly escalations: TicketEscalation[] = [];
  private readonly actorPlatform = new Map<string, string>();  // userId -> platform (for scope)
  private seq = 0;
  setActorPlatform(userId: string, platform: string) { this.actorPlatform.set(userId, platform); }
  private canSee(a: string, r: string, t: Ticket): boolean {
    if (r === "platform_superadmin") return true;
    if (r === "platform_admin") return this.actorPlatform.get(a) === t.platformId;
    if (r === "admin") return t.createdBy === a;
    return false;
  }
  private mustSee(a: string, r: string, id: string): Ticket {
    const t = this.tickets.get(id); if (!t) throw new Error("TICKET_NOT_FOUND");
    if (!this.canSee(a, r, t)) throw new Error(r === "platform_admin" ? "PLATFORM_SCOPE_FORBIDDEN" : "NOT_AUTHORIZED");
    return t;
  }
  async create(a: string, r: string, p: string | null, s: string | null, subject: string, body: string, urgency: string): Promise<Ticket> {
    if (!["admin", "platform_admin", "platform_superadmin"].includes(r)) throw new Error("NOT_AUTHORIZED");
    if (!subject) throw new Error("INVALID_SUBJECT");
    if (!["low", "medium", "high", "critical"].includes(urgency)) throw new Error("INVALID_URGENCY");
    const level = r === "platform_admin" ? 1 : 0;
    const platform = p ?? this.actorPlatform.get(a) ?? "10000000-0000-0000-0000-000000000001";
    const now = Date.now();
    const t: Ticket = { id: randomUUID(), platformId: platform, siteId: s, createdBy: a, createdByRole: r, subject, body: body ?? "", urgency, status: "open", escalationLevel: level, assigneeRole: level === 0 ? "platform_admin" : "platform_superadmin", slaDueAtMs: level === 0 ? now + 3600_000 : null, firstResponseAtMs: null, resolvedAtMs: null, resolvedBy: null, closedAtMs: null, createdAtMs: now, updatedAtMs: now };
    this.tickets.set(t.id, t); return { ...t };
  }
  async list(a: string, r: string, opts: TicketListOpts): Promise<Ticket[]> {
    return [...this.tickets.values()].filter((t) => this.canSee(a, r, t))
      .filter((t) => (!opts.status || t.status === opts.status) && (!opts.urgency || t.urgency === opts.urgency))
      .sort((x, y) => y.createdAtMs - x.createdAtMs).slice(0, opts.limit ?? 50).map((t) => ({ ...t }));
  }
  async get(a: string, r: string, id: string): Promise<TicketDetail> {
    const t = this.mustSee(a, r, id);
    return { ticket: { ...t }, comments: this.comments.filter((c) => c.ticketId === id), escalations: this.escalations.filter((e) => e.ticketId === id) };
  }
  async addComment(a: string, r: string, id: string, body: string): Promise<TicketComment> {
    const t = this.mustSee(a, r, id); if (!body) throw new Error("INVALID_BODY");
    if (a !== t.createdBy) t.firstResponseAtMs = t.firstResponseAtMs ?? Date.now();
    const c: TicketComment = { id: ++this.seq, ticketId: id, authorId: a, authorRole: r, body, createdAtMs: Date.now() };
    this.comments.push(c); return { ...c };
  }
  async setStatus(a: string, r: string, id: string, status: string, note: string | null): Promise<Ticket> {
    const t = this.mustSee(a, r, id); if (!["open", "in_progress", "resolved", "closed"].includes(status)) throw new Error("INVALID_STATUS");
    t.status = status; t.updatedAtMs = Date.now();
    if (status === "resolved") { t.resolvedAtMs = Date.now(); t.resolvedBy = a; }
    if (status === "closed") t.closedAtMs = Date.now();
    if (note) this.comments.push({ id: ++this.seq, ticketId: id, authorId: a, authorRole: r, body: `[${status}] ${note}`, createdAtMs: Date.now() });
    return { ...t };
  }
  async escalate(a: string, r: string, id: string, note: string | null): Promise<Ticket> {
    const t = this.mustSee(a, r, id); if (t.escalationLevel >= 1) throw new Error("ALREADY_AT_TOP_LEVEL");
    t.escalationLevel = 1; t.assigneeRole = "platform_superadmin"; t.slaDueAtMs = null; if (t.status === "open") t.status = "in_progress"; t.updatedAtMs = Date.now();
    this.escalations.push({ id: ++this.seq, ticketId: id, fromLevel: 0, toLevel: 1, fromRole: "platform_admin", toRole: "platform_superadmin", reason: "manual", note, actorId: a, actorRole: r, createdAtMs: Date.now() });
    return { ...t };
  }
  async autoEscalate(): Promise<number> { return 0; }
}

export class TicketService {
  constructor(private readonly repo: TicketRepository) {}
  create(actorId: string, actorRole: string, platformId: string | null, siteId: string | null, subject: string, body: string, urgency: string) {
    if (!subject || !subject.trim()) throw new Error("INVALID_SUBJECT");
    if (!["low", "medium", "high", "critical"].includes(urgency)) throw new Error("INVALID_URGENCY");
    return this.repo.create(actorId, actorRole, platformId, siteId, subject.trim(), body ?? "", urgency);
  }
  list(actorId: string, actorRole: string, opts: TicketListOpts) { return this.repo.list(actorId, actorRole, opts); }
  get(actorId: string, actorRole: string, id: string) { return this.repo.get(actorId, actorRole, id); }
  addComment(actorId: string, actorRole: string, id: string, body: string) { if (!body || !body.trim()) throw new Error("INVALID_BODY"); return this.repo.addComment(actorId, actorRole, id, body.trim()); }
  setStatus(actorId: string, actorRole: string, id: string, status: string, note: string | null = null) { return this.repo.setStatus(actorId, actorRole, id, status, note); }
  escalate(actorId: string, actorRole: string, id: string, note: string | null = null) { return this.repo.escalate(actorId, actorRole, id, note); }
  autoEscalate() { return this.repo.autoEscalate(); }
}
