import { createHmac, timingSafeEqual } from "node:crypto";
import { type Router, type Ctx, ApiError, requireAuth, requireSite, requireSiteAdmin, adminListSite, rateLimit } from "./http.js";
import type { ApiDeps } from "./app.js";

/**
 * CHAT-1 (migration 0167) — human live chat between a signed-in player and the brand's support team.
 *
 *   Player  GET  /chat                      the open (or latest) thread + messages + contact info
 *           GET  /chat/messages?after=      new messages since an id (polled every few seconds)
 *           POST /chat/messages             { body, attachmentId? }  (opens a thread on first use)
 *           POST /chat/attachments          raw bytes, Content-Type = the file's MIME type
 *           POST /chat/read                 clears the player's unread count
 *   Agent   GET  /admin/chat/threads        brand-scoped inbox (status / search)
 *           GET  /admin/chat/unread         unread total for the nav badge
 *           GET  /admin/chat/threads/:id    thread + messages (?after= to poll)
 *           POST /admin/chat/threads/:id/messages | /attachments | /read | /status
 *   Media   GET  /chat/media/:id?t=         attachment bytes; `t` is a short-lived signed token that
 *                                           the thread's reads hand out (so <img>/<video> can load it)
 *
 * Money-free. The DB functions enforce thread ownership, attachment type/size and unread counters;
 * this layer enforces who may touch which thread (player = owner; agent = the thread's brand).
 */
export interface ChatThread {
  id: string; siteId: string; userId: string; username: string | null; phone: string | null;
  status: "open" | "resolved"; playerUnread: number; agentUnread: number;
  lastMessageAt: string; lastPreview: string | null; createdAt: string;
}
export interface ChatAttachmentMeta { id: string; kind: "image" | "video" | "audio"; mime: string; sizeBytes: number }
export interface ChatMessage {
  id: number; threadId: string; authorRole: "player" | "agent" | "system"; authorName: string | null;
  body: string; attachment: ChatAttachmentMeta | null; createdAt: string;
}
export interface LiveChatStore {
  /** The player's open thread, else their most recent one, else null. */
  playerThread(userId: string): Promise<ChatThread | null>;
  openThread(userId: string, siteId: string): Promise<string>;
  getThread(threadId: string): Promise<ChatThread | null>;
  messages(threadId: string, afterId: number, limit: number): Promise<ChatMessage[]>;
  post(threadId: string, role: "player" | "agent", authorId: string, body: string, attachmentId: string | null): Promise<number>;
  attach(threadId: string, uploaderId: string, mime: string, data: Buffer): Promise<string>;
  attachment(id: string): Promise<{ id: string; threadId: string; siteId: string; mime: string; data: Buffer } | null>;
  markRead(threadId: string, reader: "player" | "agent"): Promise<void>;
  setStatus(threadId: string, actorId: string, status: "open" | "resolved"): Promise<void>;
  listThreads(siteId: string | null, status: "open" | "resolved" | "all", search: string | null, limit: number): Promise<ChatThread[]>;
  agentUnread(siteId: string | null): Promise<number>;
  /** The brand's support contacts shown in the chat greeting. */
  contacts(siteId: string): Promise<{ email: string | null; whatsapp: string | null; brandName: string }>;
}
export interface LiveChatDeps { store: LiveChatStore; mediaSecret: string; }

const BASE = "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD = 15 * 1024 * 1024;
const MEDIA_TTL_MS = 60 * 60 * 1000;

const CHAT_ERRORS: Record<string, [number, string]> = {
  THREAD_NOT_FOUND: [404, "This conversation no longer exists."],
  NOT_YOUR_BRAND: [403, "This account belongs to another brand."],
  EMPTY_MESSAGE: [400, "Write a message or attach a file."],
  MESSAGE_TOO_LONG: [400, "Messages can be up to 4,000 characters."],
  ATTACHMENT_NOT_FOUND: [400, "That attachment is not part of this conversation."],
  THREAD_CLOSED: [409, "This conversation was closed. Send a new message to start another."],
  UNSUPPORTED_FILE: [415, "Send a photo (JPG, PNG, WebP, GIF), a short video (MP4, WebM, MOV) or a voice note."],
  EMPTY_FILE: [400, "That file is empty."],
  FILE_TOO_LARGE: [413, "That file is too large: photos up to 5 MB, videos up to 15 MB, voice notes up to 3 MB."],
  INVALID_STATUS: [400, "Status must be open or resolved."],
  PLAYER_HAS_OPEN_THREAD: [409, "This player already has an open conversation."],
};
async function chatDomain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = (err instanceof Error ? err.message : String(err)).split(":")[0]!.trim();
    const hit = CHAT_ERRORS[code];
    if (hit) throw new ApiError(code, hit[1], hit[0]);
    throw err;
  }
}

/** Signed, short-lived media token: `<expMs>.<hmac>` over the attachment id. */
export function signMedia(secret: string, id: string, now = Date.now()): string {
  const exp = now + MEDIA_TTL_MS;
  const sig = createHmac("sha256", secret).update(`${id}.${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}
export function verifyMedia(secret: string, id: string, token: string, now = Date.now()): boolean {
  const [expS, sig] = token.split(".");
  const exp = Number(expS);
  if (!sig || !Number.isFinite(exp) || exp < now) return false;
  const want = createHmac("sha256", secret).update(`${id}.${exp}`).digest();
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

function threadDto(t: ChatThread) {
  return {
    id: t.id, siteId: t.siteId, userId: t.userId, username: t.username, phone: t.phone, status: t.status,
    playerUnread: t.playerUnread, agentUnread: t.agentUnread, lastMessageAt: t.lastMessageAt, lastPreview: t.lastPreview, createdAt: t.createdAt,
  };
}

export function registerLiveChatRoutes(router: Router, deps: ApiDeps): void {
  const chat = deps.liveChat;
  if (!chat) return;
  const { store, mediaSecret } = chat;
  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  const agent = requireSiteAdmin("admin");
  const sendLimit = rateLimit({ name: "chat-send", by: "user", limit: Number(process.env.CHAT_SEND_PER_MIN ?? 30), windowMs: 60_000 });
  const uploadLimit = rateLimit({ name: "chat-upload", by: "user", limit: Number(process.env.CHAT_UPLOAD_PER_MIN ?? 10), windowMs: 60_000 });

  const media = (m: ChatMessage) => m.attachment
    ? { ...m.attachment, url: `${BASE}/chat/media/${m.attachment.id}?t=${encodeURIComponent(signMedia(mediaSecret, m.attachment.id))}` }
    : null;
  const msgDto = (m: ChatMessage) => ({ id: m.id, authorRole: m.authorRole, authorName: m.authorName, body: m.body, attachment: media(m), createdAt: m.createdAt });
  /** Players never see an agent's account name — every agent reply reads as the brand's support. */
  const playerMsgDto = (m: ChatMessage) => ({ ...msgDto(m), authorName: m.authorRole === "agent" ? "Support" : m.authorRole === "player" ? "You" : null });

  /** Players (and marketers) only: operators answer from the back office, never as a customer. */
  const customer = (ctx: Ctx) => {
    const role = ctx.claims?.role ?? "player";
    if (role !== "player" && role !== "marketer") throw new ApiError("CUSTOMERS_ONLY", "Live chat is for players. Answer chats from the back office.", 403);
  };
  const afterOf = (ctx: Ctx) => {
    const n = Number(ctx.query.get("after") ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const threadForAgent = async (ctx: Ctx): Promise<ChatThread> => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "conversation id must be a UUID", 400);
    const t = await store.getThread(id);
    const scope = adminListSite(ctx) ?? null;
    if (!t || (scope !== null && t.siteId !== scope)) throw new ApiError("NOT_FOUND", "conversation not found", 404);
    return t;
  };

  // ── Player ──
  router.get(`${BASE}/chat`, auth, site, async (ctx: Ctx) => {
    customer(ctx);
    const t = await store.playerThread(ctx.claims!.userId);
    const contacts = await store.contacts(ctx.siteId!);
    return { thread: t ? threadDto(t) : null, messages: t ? (await store.messages(t.id, 0, 200)).map(playerMsgDto) : [], contacts };
  });
  router.get(`${BASE}/chat/messages`, auth, site, async (ctx: Ctx) => {
    customer(ctx);
    const t = await store.playerThread(ctx.claims!.userId);
    if (!t) return { thread: null, messages: [] };
    return { thread: threadDto(t), messages: (await store.messages(t.id, afterOf(ctx), 200)).map(playerMsgDto) };
  });
  router.post(`${BASE}/chat/messages`, auth, site, sendLimit, async (ctx: Ctx) => {
    customer(ctx);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const body = typeof b.body === "string" ? b.body : "";
    const attachmentId = typeof b.attachmentId === "string" && UUID_RE.test(b.attachmentId) ? b.attachmentId : null;
    const threadId = await chatDomain(() => store.openThread(ctx.claims!.userId, ctx.siteId!));
    const id = await chatDomain(() => store.post(threadId, "player", ctx.claims!.userId, body, attachmentId));
    return { status: 201, body: { id, threadId } };
  });
  router.upload(`${BASE}/chat/attachments`, MAX_UPLOAD, auth, site, uploadLimit, async (ctx: Ctx) => {
    customer(ctx);
    const mime = String(ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const threadId = await chatDomain(() => store.openThread(ctx.claims!.userId, ctx.siteId!));
    const id = await chatDomain(() => store.attach(threadId, ctx.claims!.userId, mime, ctx.body as Buffer));
    return { status: 201, body: { id, threadId } };
  });
  router.post(`${BASE}/chat/read`, auth, site, async (ctx: Ctx) => {
    customer(ctx);
    const t = await store.playerThread(ctx.claims!.userId);
    if (t) await store.markRead(t.id, "player");
    return { ok: true };
  });

  // ── Media (signed link; no bearer so <img>/<video>/<audio> can load it) ──
  router.get(`${BASE}/chat/media/:id`, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    const t = ctx.query.get("t") ?? "";
    if (!UUID_RE.test(id) || !verifyMedia(mediaSecret, id, t)) throw new ApiError("NOT_FOUND", "file not found", 404);
    const a = await store.attachment(id);
    if (!a) throw new ApiError("NOT_FOUND", "file not found", 404);
    return { raw: a.data, contentType: a.mime, cacheSeconds: 3600 };
  });

  // ── Agents (back office; brand-scoped) ──
  router.get(`${BASE}/admin/chat/threads`, auth, site, agent, async (ctx: Ctx) => {
    const st = ctx.query.get("status");
    const status = st === "resolved" || st === "all" ? st : "open";
    const q = (ctx.query.get("q") ?? "").trim().slice(0, 64) || null;
    const items = await store.listThreads(adminListSite(ctx) ?? null, status, q, 100);
    return { items: items.map(threadDto) };
  });
  router.get(`${BASE}/admin/chat/unread`, auth, site, agent, async (ctx: Ctx) => {
    return { count: await store.agentUnread(adminListSite(ctx) ?? null) };
  });
  router.get(`${BASE}/admin/chat/threads/:id`, auth, site, agent, async (ctx: Ctx) => {
    const t = await threadForAgent(ctx);
    return { thread: threadDto(t), messages: (await store.messages(t.id, afterOf(ctx), 300)).map(msgDto) };
  });
  router.post(`${BASE}/admin/chat/threads/:id/messages`, auth, site, agent, async (ctx: Ctx) => {
    const t = await threadForAgent(ctx);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const attachmentId = typeof b.attachmentId === "string" && UUID_RE.test(b.attachmentId) ? b.attachmentId : null;
    const id = await chatDomain(() => store.post(t.id, "agent", ctx.claims!.userId, typeof b.body === "string" ? b.body : "", attachmentId));
    await store.markRead(t.id, "agent");
    return { status: 201, body: { id } };
  });
  router.upload(`${BASE}/admin/chat/threads/:id/attachments`, MAX_UPLOAD, auth, site, agent, async (ctx: Ctx) => {
    const t = await threadForAgent(ctx);
    const mime = String(ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const id = await chatDomain(() => store.attach(t.id, ctx.claims!.userId, mime, ctx.body as Buffer));
    return { status: 201, body: { id } };
  });
  router.post(`${BASE}/admin/chat/threads/:id/read`, auth, site, agent, async (ctx: Ctx) => {
    const t = await threadForAgent(ctx);
    await store.markRead(t.id, "agent");
    return { ok: true };
  });
  router.post(`${BASE}/admin/chat/threads/:id/status`, auth, site, agent, async (ctx: Ctx) => {
    const t = await threadForAgent(ctx);
    const st = ((ctx.body ?? {}) as Record<string, unknown>).status;
    if (st !== "open" && st !== "resolved") throw new ApiError("INVALID_STATUS", "Status must be open or resolved.", 400);
    await chatDomain(() => store.setStatus(t.id, ctx.claims!.userId, st));
    return { ok: true };
  });
}

/** In-memory store (tests / dev). Mirrors the 0167 rules that the API relies on. */
export class InMemoryLiveChatStore implements LiveChatStore {
  threads = new Map<string, ChatThread>();
  msgs: (ChatMessage & { authorId: string | null })[] = [];
  files = new Map<string, { id: string; threadId: string; siteId: string; mime: string; data: Buffer; kind: "image" | "video" | "audio" }>();
  users = new Map<string, { siteId: string; username: string }>();
  contactsBySite = new Map<string, { email: string | null; whatsapp: string | null; brandName: string }>();
  private seq = 0;
  private uid = 0;
  private id() { this.uid += 1; return `00000000-0000-4000-8000-${String(this.uid).padStart(12, "0")}`; }
  async playerThread(userId: string) {
    const mine = [...this.threads.values()].filter((t) => t.userId === userId);
    return mine.find((t) => t.status === "open") ?? mine.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))[0] ?? null;
  }
  async openThread(userId: string, siteId: string) {
    const u = this.users.get(userId);
    if (u && u.siteId !== siteId) throw new Error("NOT_YOUR_BRAND");
    const open = [...this.threads.values()].find((t) => t.userId === userId && t.status === "open");
    if (open) return open.id;
    const now = new Date().toISOString();
    const t: ChatThread = { id: this.id(), siteId, userId, username: u?.username ?? null, phone: null, status: "open", playerUnread: 0, agentUnread: 0, lastMessageAt: now, lastPreview: null, createdAt: now };
    this.threads.set(t.id, t);
    return t.id;
  }
  async getThread(id: string) { return this.threads.get(id) ?? null; }
  async messages(threadId: string, after: number, limit: number) {
    return this.msgs.filter((m) => m.threadId === threadId && m.id > after).slice(0, limit).map(({ authorId: _a, ...m }) => m);
  }
  async post(threadId: string, role: "player" | "agent", authorId: string, body: string, attachmentId: string | null) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("THREAD_NOT_FOUND");
    const text = body.trim();
    if (!text && !attachmentId) throw new Error("EMPTY_MESSAGE");
    if (text.length > 4000) throw new Error("MESSAGE_TOO_LONG");
    const f = attachmentId ? this.files.get(attachmentId) : null;
    if (attachmentId && (!f || f.threadId !== threadId)) throw new Error("ATTACHMENT_NOT_FOUND");
    if (t.status === "resolved" && role === "player") throw new Error("THREAD_CLOSED");
    const id = ++this.seq;
    this.msgs.push({ id, threadId, authorRole: role, authorName: null, authorId, body: text, attachment: f ? { id: f.id, kind: f.kind, mime: f.mime, sizeBytes: f.data.length } : null, createdAt: new Date().toISOString() });
    t.lastMessageAt = new Date().toISOString(); t.lastPreview = text || `[${f!.kind}]`;
    if (role === "player") t.agentUnread += 1; else { t.playerUnread += 1; t.status = "open"; }
    return id;
  }
  async attach(threadId: string, _uploader: string, mime: string, data: Buffer) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("THREAD_NOT_FOUND");
    const kind = /^image\/(jpeg|png|webp|gif)$/.test(mime) ? "image" : /^video\/(mp4|webm|quicktime)$/.test(mime) ? "video" : /^audio\/(webm|ogg|mpeg|mp4|aac|wav)$/.test(mime) ? "audio" : null;
    if (!kind) throw new Error("UNSUPPORTED_FILE");
    if (!data.length) throw new Error("EMPTY_FILE");
    const cap = kind === "image" ? 5242880 : kind === "video" ? 15728640 : 3145728;
    if (data.length > cap) throw new Error("FILE_TOO_LARGE");
    const id = this.id();
    this.files.set(id, { id, threadId, siteId: t.siteId, mime, data, kind });
    return id;
  }
  async attachment(id: string) { return this.files.get(id) ?? null; }
  async markRead(threadId: string, reader: "player" | "agent") { const t = this.threads.get(threadId); if (t) { if (reader === "player") t.playerUnread = 0; else t.agentUnread = 0; } }
  async setStatus(threadId: string, _actor: string, status: "open" | "resolved") {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("THREAD_NOT_FOUND");
    if (t.status === status) return;
    if (status === "open" && [...this.threads.values()].some((x) => x.userId === t.userId && x.status === "open")) throw new Error("PLAYER_HAS_OPEN_THREAD");
    t.status = status; if (status === "resolved") t.agentUnread = 0;
    this.msgs.push({ id: ++this.seq, threadId, authorRole: "system", authorName: null, authorId: null, body: status === "resolved" ? "Conversation marked as resolved." : "Conversation reopened.", attachment: null, createdAt: new Date().toISOString() });
  }
  async listThreads(siteId: string | null, status: "open" | "resolved" | "all", search: string | null, limit: number) {
    return [...this.threads.values()]
      .filter((t) => t.lastPreview !== null && (siteId === null || t.siteId === siteId) && (status === "all" || t.status === status) && (!search || (t.username ?? "").includes(search)))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, limit);
  }
  async agentUnread(siteId: string | null) { return [...this.threads.values()].filter((t) => siteId === null || t.siteId === siteId).reduce((n, t) => n + t.agentUnread, 0); }
  async contacts(siteId: string) { return this.contactsBySite.get(siteId) ?? { email: null, whatsapp: null, brandName: "Brand" }; }
}
