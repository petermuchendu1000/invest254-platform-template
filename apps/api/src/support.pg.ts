import type { Querier } from "@invest254/engine";
import type { EmbedFn, LlmFn, LlmMessage, SearchKbFn, SupportBrandInfo, SupportCitation } from "@invest254/shared";
import type { SupportConversation, SupportMessageRow, SupportStore, SupportDeps } from "./app.support.js";

/**
 * Production support-chat adapters (migration 0057). All grounded-answer logic lives in
 * @invest254/shared; this file only binds the injected ports to real infrastructure:
 *   - store     -> the fn_support_start/log/escalate RPCs + brand-scoped operator reads
 *   - searchKb  -> fn_kb_search (pgvector cosine top-k)
 *   - embed     -> Cloudflare Workers AI @cf/baai/bge-small-en-v1.5 (SAME model + 384 dims as
 *                  the ingest embedder, so query and stored vectors are compatible), free tier
 *   - llm       -> any OpenAI-compatible free endpoint (Groq by default), env-configured
 *   - brandInfo -> the sites row (name, support email, currency)
 *
 * Everything is free-tier friendly and swappable via environment variables; nothing here runs
 * in the test suite (tests inject deterministic fakes via testutil.makeSupportHarness).
 */

const vecLiteral = (v: number[]): string => "[" + v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",") + "]";
const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : typeof v === "string" ? Number(v) : (v as number));

function mapConversation(x: Record<string, unknown>): SupportConversation {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: String(x.id),
    siteId: String(x.site_id),
    userId: (x.user_id as string | null) ?? null,
    visitorId: (x.visitor_id as string | null) ?? null,
    status: String(x.status) as SupportConversation["status"],
    escalated: Boolean(x.escalated),
    contactEmail: (x.contact_email as string | null) ?? null,
    contactPhone: (x.contact_phone as string | null) ?? null,
    createdAt: iso(x.created_at),
    lastAt: iso(x.last_at),
  };
}

function mapMessage(x: Record<string, unknown>): SupportMessageRow {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  const sources = Array.isArray(x.sources) ? (x.sources as SupportCitation[]) : (typeof x.sources === "string" ? JSON.parse(x.sources) as SupportCitation[] : []);
  return {
    id: String(x.id),
    conversationId: String(x.conversation_id),
    siteId: String(x.site_id),
    role: String(x.role) as SupportMessageRow["role"],
    content: String(x.content),
    sources,
    confidence: toNum(x.confidence),
    createdAt: iso(x.created_at),
  };
}

/** SupportStore over the 0057 RPCs + brand-scoped reads (the API runs as service_role). */
export function makePgSupportStore(q: Querier): SupportStore {
  return {
    async start(siteId, opts) {
      const r = await q.query("select fn_support_start($1,$2,$3) as id", [siteId, opts.visitorId ?? null, opts.userId ?? null]);
      return String(r.rows[0]!.id);
    },
    async log(conversationId, role, content, sources, confidence) {
      const r = await q.query(
        "select fn_support_log($1,$2,$3,$4::jsonb,$5) as id",
        [conversationId, role, content, JSON.stringify(sources ?? []), confidence],
      );
      return String(r.rows[0]!.id);
    },
    async escalate(conversationId, contact) {
      await q.query("select fn_support_escalate($1,$2,$3)", [conversationId, contact.email ?? null, contact.phone ?? null]);
    },
    async getConversation(conversationId) {
      const r = await q.query(
        `select id, site_id, user_id, visitor_id, status, escalated, contact_email, contact_phone, created_at, last_at
           from support_conversations where id = $1`,
        [conversationId],
      );
      return r.rows.length ? mapConversation(r.rows[0] as Record<string, unknown>) : null;
    },
    async listMessages(conversationId) {
      const r = await q.query(
        `select id, conversation_id, site_id, role, content, sources, confidence, created_at
           from support_messages where conversation_id = $1 order by created_at asc`,
        [conversationId],
      );
      return r.rows.map((x: Record<string, unknown>) => mapMessage(x));
    },
    async listConversations(scope, opts) {
      const r = await q.query(
        `select id, site_id, user_id, visitor_id, status, escalated, contact_email, contact_phone, created_at, last_at
           from support_conversations
          where ($1::uuid is null or site_id = $1)
          order by last_at desc
          limit $2`,
        [scope, opts.limit],
      );
      return r.rows.map((x: Record<string, unknown>) => mapConversation(x));
    },
  };
}

/** fn_kb_search adapter: embeds the query vector as a pgvector literal and returns hits. */
export function makePgSearchKb(q: Querier): SearchKbFn {
  return async (siteId, embedding, k) => {
    const r = await q.query(
      "select source, heading, content, distance from fn_kb_search($1, $2::vector, $3)",
      [siteId, vecLiteral(embedding), k],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      source: String(x.source),
      heading: (x.heading as string | null) ?? null,
      content: String(x.content),
      distance: Number(x.distance),
    }));
  };
}

/**
 * Cloudflare Workers AI embedder: @cf/baai/bge-small-en-v1.5 (384-dim, normalised) on the free
 * tier. Env: CF_ACCOUNT_ID, CF_AI_API_TOKEN (optionally CF_EMBED_MODEL to override).
 */
export function makeCloudflareEmbedder(): EmbedFn {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_AI_API_TOKEN;
  const model = process.env.CF_EMBED_MODEL ?? "@cf/baai/bge-small-en-v1.5";
  if (!account || !token) throw new Error("SUPPORT: CF_ACCOUNT_ID and CF_AI_API_TOKEN are required for the Cloudflare embedder");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`;
  return async (texts) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "invest254-support/1.0" },
      body: JSON.stringify({ text: texts }),
    });
    if (!res.ok) throw new Error(`EMBED_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { result?: { data?: number[][] } };
    const data = body.result?.data;
    if (!Array.isArray(data)) throw new Error("EMBED_BAD_RESPONSE");
    return data;
  };
}

/**
 * OpenAI-compatible chat-completions LLM (Groq free tier by default; any compatible endpoint via
 * SUPPORT_LLM_BASE_URL). Env: SUPPORT_LLM_API_KEY (required), SUPPORT_LLM_MODEL, SUPPORT_LLM_BASE_URL.
 */
export function makeOpenAiCompatibleLlm(): LlmFn {
  const baseUrl = process.env.SUPPORT_LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
  const apiKey = process.env.SUPPORT_LLM_API_KEY ?? process.env.GROQ_API_KEY;
  const model = process.env.SUPPORT_LLM_MODEL ?? "llama-3.1-8b-instant";
  if (!apiKey) throw new Error("SUPPORT: SUPPORT_LLM_API_KEY (or GROQ_API_KEY) is required for the LLM adapter");
  return async (messages: LlmMessage[], opts) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "invest254-support/1.0" },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts?.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? 500,
      }),
    });
    if (!res.ok) throw new Error(`LLM_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  };
}

/** Resolve brand facts for the grounded prompt from the sites row. */
export function makeBrandInfo(q: Querier): (siteId: string) => Promise<SupportBrandInfo> {
  return async (siteId) => {
    const r = await q.query("select name, support_email, currency from sites where id = $1", [siteId]);
    const x = r.rows[0] as Record<string, unknown> | undefined;
    return {
      name: x ? String(x.name) : "Invest254",
      supportEmail: (x?.support_email as string | null) ?? null,
      currency: x ? String(x.currency ?? "KES") : "KES",
    };
  };
}

/**
 * Assemble the production SupportDeps, or return undefined when the feature is not configured
 * (no embedder/LLM creds) so existing deployments are unaffected. Enable by setting the
 * Cloudflare embedder + LLM env vars (and optionally SUPPORT_CHAT_ENABLED=false to force-off).
 */
export function makePgSupportDeps(q: Querier): SupportDeps | undefined {
  if (process.env.SUPPORT_CHAT_ENABLED === "false") return undefined;
  const haveEmbed = Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_AI_API_TOKEN);
  const haveLlm = Boolean(process.env.SUPPORT_LLM_API_KEY || process.env.GROQ_API_KEY);
  if (!haveEmbed || !haveLlm) return undefined;
  return {
    store: makePgSupportStore(q),
    embed: makeCloudflareEmbedder(),
    llm: makeOpenAiCompatibleLlm(),
    searchKb: makePgSearchKb(q),
    brandInfo: makeBrandInfo(q),
  };
}
