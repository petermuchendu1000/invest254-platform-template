import type { ChatMessage, ChatThread, LiveChatStore } from "./app.livechat.js";

/** CHAT-1: LiveChatStore over the 0167 RPCs + brand-scoped reads (the API runs as service_role). */
export interface ChatQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const THREAD_COLS = `t.id, t.site_id, t.user_id, p.username, p.phone, t.status, t.player_unread, t.agent_unread,
                     t.last_message_at, t.last_preview, t.created_at`;

function mapThread(x: Record<string, unknown>): ChatThread {
  return {
    id: String(x.id), siteId: String(x.site_id), userId: String(x.user_id),
    username: (x.username as string | null) ?? null, phone: (x.phone as string | null) ?? null,
    status: x.status === "resolved" ? "resolved" : "open",
    playerUnread: Number(x.player_unread ?? 0), agentUnread: Number(x.agent_unread ?? 0),
    lastMessageAt: iso(x.last_message_at), lastPreview: (x.last_preview as string | null) ?? null, createdAt: iso(x.created_at),
  };
}

export function makePgLiveChatStore(q: ChatQuerier): LiveChatStore {
  return {
    async playerThread(userId) {
      const r = await q.query(
        `select ${THREAD_COLS} from chat_threads t join profiles p on p.id = t.user_id
          where t.user_id = $1 order by (t.status = 'open') desc, t.last_message_at desc limit 1`, [userId]);
      return r.rows.length ? mapThread(r.rows[0]!) : null;
    },
    async openThread(userId, siteId) {
      const r = await q.query("select fn_chat_open_thread($1, $2) as id", [userId, siteId]);
      return String(r.rows[0]!.id);
    },
    async getThread(id) {
      const r = await q.query(`select ${THREAD_COLS} from chat_threads t join profiles p on p.id = t.user_id where t.id = $1`, [id]);
      return r.rows.length ? mapThread(r.rows[0]!) : null;
    },
    async messages(threadId, afterId, limit) {
      // newest `limit` after `afterId`, returned oldest-first
      const r = await q.query(
        `select * from (
           select m.id, m.thread_id, m.author_role, m.body, m.created_at, p.username as author_name,
                  a.id as att_id, a.kind as att_kind, a.mime as att_mime, a.size_bytes as att_size
             from chat_messages m
             left join profiles p on p.id = m.author_id
             left join chat_attachments a on a.id = m.attachment_id
            where m.thread_id = $1 and m.id > $2
            order by m.id desc limit $3) x order by id asc`,
        [threadId, afterId, limit]);
      return r.rows.map((x): ChatMessage => ({
        id: Number(x.id), threadId: String(x.thread_id),
        authorRole: x.author_role as ChatMessage["authorRole"],
        // players see "Support" for agents; the back office sees the agent's name (set by the route layer)
        authorName: (x.author_name as string | null) ?? null,
        body: String(x.body ?? ""),
        attachment: x.att_id ? { id: String(x.att_id), kind: x.att_kind as "image" | "video" | "audio", mime: String(x.att_mime), sizeBytes: Number(x.att_size) } : null,
        createdAt: iso(x.created_at),
      }));
    },
    async post(threadId, role, authorId, body, attachmentId) {
      const r = await q.query("select fn_chat_post($1, $2, $3, $4, $5) as id", [threadId, role, authorId, body, attachmentId]);
      return Number(r.rows[0]!.id);
    },
    async attach(threadId, uploaderId, mime, data) {
      const r = await q.query("select fn_chat_attach($1, $2, $3, $4) as id", [threadId, uploaderId, mime, data]);
      return String(r.rows[0]!.id);
    },
    async attachment(id) {
      const r = await q.query("select id, thread_id, site_id, mime, data from chat_attachments where id = $1", [id]);
      if (!r.rows.length) return null;
      const x = r.rows[0]!;
      return { id: String(x.id), threadId: String(x.thread_id), siteId: String(x.site_id), mime: String(x.mime), data: x.data as Buffer };
    },
    async markRead(threadId, reader) { await q.query("select fn_chat_mark_read($1, $2)", [threadId, reader]); },
    async setStatus(threadId, actorId, status) { await q.query("select fn_chat_set_status($1, $2, $3)", [threadId, actorId, status]); },
    async listThreads(siteId, status, search, limit) {
      const r = await q.query(
        `select ${THREAD_COLS} from chat_threads t join profiles p on p.id = t.user_id
          where ($1::uuid is null or t.site_id = $1)
            and t.last_preview is not null   -- a thread with no message yet (upload in progress) is not shown
            and ($2 = 'all' or t.status = $2)
            and ($3::text is null or p.username ilike '%' || $3 || '%' or p.phone like '%' || $3 || '%')
          order by t.agent_unread > 0 desc, t.last_message_at desc
          limit $4`,
        [siteId, status, search, limit]);
      return r.rows.map(mapThread);
    },
    async agentUnread(siteId) {
      const r = await q.query("select coalesce(sum(agent_unread), 0)::int as n from chat_threads where ($1::uuid is null or site_id = $1) and status = 'open'", [siteId]);
      return Number(r.rows[0]?.n ?? 0);
    },
    async contacts(siteId) {
      const r = await q.query("select name, support_email, support_whatsapp from sites where id = $1", [siteId]);
      const x = r.rows[0] ?? {};
      return { email: (x.support_email as string | null) ?? null, whatsapp: (x.support_whatsapp as string | null) ?? null, brandName: String(x.name ?? "Support") };
    },
  };
}
