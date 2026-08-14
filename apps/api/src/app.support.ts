import {
  answerSupportQuestion,
  type EmbedFn,
  type LlmFn,
  type SearchKbFn,
  type SupportPolicy,
  type SupportBrandInfo,
  type SupportCitation,
  type SupportHistoryTurn,
} from "@invest254/shared";
import {
  Router, ApiError, requireAuth, requireRole, requireSite, rateLimit, DEFAULT_SITE_ID,
  adminScopeSite, type Ctx, type Middleware,
} from "./http.js";
import type { ApiDeps } from "./app.js";
import type { Verifier } from "@invest254/engine";

/**
 * Support-chat REST surface (docs/11 chat, backend migration 0057). A Tawk-style autonomous
 * assistant: a visitor opens a conversation, asks in natural language, and the server grounds
 * an answer in the knowledge base (RAG) via a free LLM, records every turn for operators, and
 * can escalate to a human. Public endpoints are anonymous-friendly (optional bearer attributes
 * the turn to a logged-in player); operator reads require an admin role and are brand-scoped.
 *
 * This module owns only transport: routing, validation, auth/role gates, site scoping,
 * (de)serialization, and rate limiting. The grounded-answer logic is the pure
 * `answerSupportQuestion` in @invest254/shared; recording is the injected `SupportStore`.
 */

const BASE = "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SUPPORT_MAX_MESSAGE = 1000;

// ── Recording store (mirrors the 0057 RPCs fn_support_start/log/escalate + operator reads) ──
export type SupportConvStatus = "open" | "resolved" | "escalated";

export interface SupportConversation {
  id: string;
  siteId: string;
  userId: string | null;
  visitorId: string | null;
  status: SupportConvStatus;
  escalated: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  lastAt: string;
}

export interface SupportMessageRow {
  id: string;
  conversationId: string;
  siteId: string;
  role: "user" | "assistant" | "system";
  content: string;
  sources: SupportCitation[];
  confidence: number | null;
  createdAt: string;
}

export interface SupportStore {
  /** fn_support_start: open a conversation for a brand (anonymous visitor or a logged-in user). */
  start(siteId: string, opts: { userId?: string | null; visitorId?: string | null }): Promise<string>;
  /** fn_support_log: append a turn; returns the message id. */
  log(
    conversationId: string,
    role: "user" | "assistant" | "system",
    content: string,
    sources: SupportCitation[],
    confidence: number | null,
  ): Promise<string>;
  /** fn_support_escalate: flag the conversation and capture a contact. */
  escalate(conversationId: string, contact: { email?: string | null; phone?: string | null }): Promise<void>;
  /** A single conversation (for site verification + operator detail); null if unknown. */
  getConversation(conversationId: string): Promise<SupportConversation | null>;
  /** Prior turns of a conversation, oldest first (feeds the LLM history window). */
  listMessages(conversationId: string): Promise<SupportMessageRow[]>;
  /** Operator list: scope=null means all brands (platform_superadmin); else that brand only. */
  listConversations(scope: string | null, opts: { limit: number }): Promise<SupportConversation[]>;
}

/** Everything the support routes bind to. Wired to Postgres in server.ts, to fakes in tests. */
export interface SupportDeps {
  store: SupportStore;
  embed: EmbedFn;
  llm: LlmFn;
  searchKb: SearchKbFn;
  brandInfo(siteId: string): Promise<SupportBrandInfo>;
  policy?: SupportPolicy;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────
/** Read a bearer token if present and valid, attributing the caller; otherwise stay anonymous. */
function optionalAuth(verifier: Verifier | null): Middleware {
  return async (ctx) => {
    const header = ctx.req.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !verifier) return;
    try { ctx.claims = await verifier(token); } catch { /* invalid token -> anonymous */ }
  };
}

function requireString(body: unknown, field: string, max: number): string {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (typeof v !== "string" || v.trim().length === 0) throw new ApiError("INVALID_INPUT", `${field} is required`, 400);
  if (v.length > max) throw new ApiError("INPUT_TOO_LONG", `${field} exceeds ${max} characters`, 400);
  return v.trim();
}

function optionalString(body: unknown, field: string, max = 200): string | null {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError("INVALID_INPUT", `${field} must be a string`, 400);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new ApiError("INPUT_TOO_LONG", `${field} exceeds ${max} characters`, 400);
  return t;
}

const convDto = (c: SupportConversation) => ({
  id: c.id, siteId: c.siteId, userId: c.userId, visitorId: c.visitorId, status: c.status,
  escalated: c.escalated, contactEmail: c.contactEmail, contactPhone: c.contactPhone,
  createdAt: c.createdAt, lastAt: c.lastAt,
});

const msgDto = (m: SupportMessageRow) => ({
  id: m.id, role: m.role, content: m.content, sources: m.sources, confidence: m.confidence, ts: m.createdAt,
});

/** Resolve the brand a public request is acting on: authed token's site, else body/query, else default. */
function publicSiteId(ctx: Ctx): string {
  const claimSite = ctx.claims?.site;
  if (claimSite) return claimSite;
  const fromBody = (ctx.body as Record<string, unknown> | null)?.siteId;
  const fromQuery = ctx.query.get("site");
  const raw = (typeof fromBody === "string" && fromBody) || fromQuery || DEFAULT_SITE_ID;
  if (!UUID_RE.test(raw)) throw new ApiError("INVALID_SITE", "siteId must be a UUID", 400);
  return raw;
}

// ── routes ──────────────────────────────────────────────────────────────────────────────
export function registerSupportRoutes(router: Router, deps: ApiDeps): void {
  const s = deps.support;
  if (!s) return; // support is optional; skip wiring if a deployment does not enable it

  const soft = optionalAuth(deps.verifier);
  // Rate limits (per API instance). Generous defaults; override via env for stricter public caps.
  const startLimit = rateLimit({ name: "support-start", limit: Number(process.env.SUPPORT_START_LIMIT ?? 20), windowMs: Number(process.env.SUPPORT_START_WINDOW_MS ?? 10_000), by: "ip" });
  const msgLimit = rateLimit({ name: "support-message", limit: Number(process.env.SUPPORT_MSG_LIMIT ?? 30), windowMs: Number(process.env.SUPPORT_MSG_WINDOW_MS ?? 10_000), by: "ip" });

  // Open a conversation. Anonymous by default; a valid bearer attributes it to the player.
  router.post(`${BASE}/support/conversations`, soft, startLimit, async (ctx: Ctx) => {
    const siteId = publicSiteId(ctx);
    const visitorId = optionalString(ctx.body, "visitorId", 128);
    const userId = ctx.claims?.userId ?? null;
    const id = await s.store.start(siteId, { userId, visitorId });
    return { status: 201, body: { conversationId: id, siteId } };
  });

  // Ask a question -> grounded answer; both the question and the answer are recorded.
  router.post(`${BASE}/support/conversations/:id/messages`, soft, msgLimit, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "conversation id must be a UUID", 400);
    const message = requireString(ctx.body, "message", SUPPORT_MAX_MESSAGE);

    const conv = await s.store.getConversation(id);
    if (!conv) throw new ApiError("NOT_FOUND", `conversation ${id} not found`, 404);
    // A logged-in caller may only post to a conversation in their own brand.
    if (ctx.claims?.site && ctx.claims.site !== conv.siteId) {
      throw new ApiError("AUTH_SITE_MISMATCH", "conversation belongs to another brand", 403);
    }

    const priorRows = await s.store.listMessages(id);
    const history: SupportHistoryTurn[] = priorRows
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    const brand = await s.brandInfo(conv.siteId);

    // Record the visitor turn first so it is never lost even if the model call fails.
    await s.store.log(id, "user", message, [], null);

    const result = await answerSupportQuestion(
      { embed: s.embed, searchKb: s.searchKb, llm: s.llm, ...(s.policy ? { policy: s.policy } : {}) },
      { siteId: conv.siteId, question: message, history, brand },
    );

    await s.store.log(id, "assistant", result.answer, result.citations, result.confidence);

    return {
      answer: result.answer,
      citations: result.citations,
      confidence: result.confidence,
      shouldEscalate: result.shouldEscalate,
    };
  });

  // Hand off to a human: flag the conversation and capture a contact.
  router.post(`${BASE}/support/conversations/:id/escalate`, soft, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "conversation id must be a UUID", 400);
    const email = optionalString(ctx.body, "email", 254);
    const phone = optionalString(ctx.body, "phone", 32);
    if (email && !EMAIL_RE.test(email)) throw new ApiError("INVALID_EMAIL", "email is not valid", 400);
    if (!email && !phone) throw new ApiError("INVALID_INPUT", "provide an email or phone to escalate", 400);

    const conv = await s.store.getConversation(id);
    if (!conv) throw new ApiError("NOT_FOUND", `conversation ${id} not found`, 404);
    if (ctx.claims?.site && ctx.claims.site !== conv.siteId) {
      throw new ApiError("AUTH_SITE_MISMATCH", "conversation belongs to another brand", 403);
    }
    await s.store.escalate(id, { email, phone });
    return { status: "escalated" };
  });

  // ── Operator reads (admin+; brand-scoped; platform_superadmin sees all) ──
  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  const admin = requireRole("admin");

  router.get(`${BASE}/support/conversations`, auth, site, admin, async (ctx: Ctx) => {
    const scope = adminScopeSite(ctx); // null for platform_superadmin, else the caller's brand
    const rawLimit = ctx.query.get("limit");
    const limit = rawLimit === null ? 50 : Math.min(Math.max(1, Math.floor(Number(rawLimit) || 0)), 200);
    if (rawLimit !== null && (!Number.isFinite(Number(rawLimit)) || Number(rawLimit) <= 0)) {
      throw new ApiError("INVALID_LIMIT", "limit must be a positive integer", 400);
    }
    const items = await s.store.listConversations(scope, { limit });
    return { items: items.map(convDto) };
  });

  router.get(`${BASE}/support/conversations/:id`, auth, site, admin, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "conversation id must be a UUID", 400);
    const conv = await s.store.getConversation(id);
    if (!conv) throw new ApiError("NOT_FOUND", `conversation ${id} not found`, 404);
    // Brand scoping: a site admin may only read their own brand; platform_superadmin unrestricted.
    const scope = adminScopeSite(ctx);
    if (scope !== null && conv.siteId !== scope) throw new ApiError("NOT_FOUND", `conversation ${id} not found`, 404);
    const messages = await s.store.listMessages(id);
    return { conversation: convDto(conv), messages: messages.map(msgDto) };
  });
}
