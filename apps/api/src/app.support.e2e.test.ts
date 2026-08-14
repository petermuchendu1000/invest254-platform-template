import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, SITE_A, SITE_B, type TestApi, type SeedChunk } from "./testutil.js";
import type { LlmMessage } from "@invest254/shared";

/**
 * Deep END-TO-END coverage of the support-chat surface (docs/11, migration 0057), driven through
 * the real HTTP API (createApp + the pure `answerSupportQuestion` core + in-memory store/embedder/LLM).
 *
 * Invariants asserted:
 *   RAG         a question retrieves the right KB chunk, and its content reaches the LLM prompt.
 *   RECORD      every visitor + assistant turn is persisted with site_id, sources and confidence.
 *   GROUND      grounded answers cite sources and do not escalate; uncovered questions escalate.
 *   STYLE       nothing sent to a visitor contains an em dash.
 *   TENANCY     a brand's private KB never leaks to another brand; cross-brand posting is refused.
 *   RLS         operator reads require an admin role and are brand-scoped (superadmin sees all).
 *   TRANSPORT   validation, escalation, anonymous vs authed attribution, and rate limiting.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

// Tokens (see testutil.stubVerifier: `<user>:<role>:<site>`).
const ADMIN_A = `${TEST_ADMIN}:admin:${SITE_A}`;   // site-scoped admin (brand A)
const ADMIN_B = `${TEST_ADMIN}:admin:${SITE_B}`;   // site-scoped admin (brand B)
const SUPERADMIN = `${TEST_ADMIN}:platform_superadmin`; // cross-brand
const PLAYER_A = `${TEST_USER}:player:${SITE_A}`;

const SHARED_KB: SeedChunk[] = [
  { siteId: null, source: "docs/08-payments-mpesa.md", heading: "Withdrawals", content: "Withdraw funds using M-Pesa B2C directly from your wallet balance." },
  { siteId: null, source: "docs/09-affiliate-system.md", heading: "Revenue share", content: "Affiliates earn a twenty percent revenue share on referred player net losses." },
];
// Brand-B private override chunk with unique tokens that appear in no shared doc.
const BRANDB_KB: SeedChunk[] = [
  { siteId: SITE_B, source: "kb://brandb/secret", heading: "Brandb policy", content: "Brandb zephyrquux glimberton narwhalplex private escalation policy." },
];

async function startConversation(api: TestApi, body: unknown = {}, token?: string): Promise<string> {
  const r = await req(api, "POST", "/api/v1/support/conversations", token ? { token, body } : { body });
  assert.equal(r.status, 201, "conversation created");
  const { conversationId } = await json(r);
  assert.match(conversationId, /^c0000000-/);
  return conversationId;
}

// ── RAG + RECORD + GROUND + STYLE ────────────────────────────────────────────────────────
test("grounded answer: cites sources, high confidence, no escalation, no em dash, both turns recorded", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    const conv = await startConversation(api, { visitorId: "v-1" });
    const r = await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, {
      body: { message: "How do I withdraw funds using M-Pesa B2C from my wallet balance?" },
    });
    assert.equal(r.status, 200);
    const body = await json(r);

    assert.ok(body.confidence > 0.3, `confidence ${body.confidence}`);
    assert.equal(body.shouldEscalate, false);
    assert.deepEqual(body.citations[0], { source: "docs/08-payments-mpesa.md", heading: "Withdrawals" });
    assert.ok(!/[\u2014\u2013]/.test(body.answer), `answer had an em dash: ${body.answer}`);

    // RECORD: user + assistant turns persisted with site_id; assistant carries sources + confidence.
    const rows = api.support.messages.get(conv)!;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.role, "user");
    assert.equal(rows[0]!.siteId, SITE_A);
    assert.equal(rows[1]!.role, "assistant");
    assert.equal(rows[1]!.confidence, body.confidence);
    assert.ok(rows[1]!.sources.length >= 1);

    // GROUND: the retrieved KB content actually reached the model prompt.
    const lastCall = api.support.llmCalls.at(-1) as LlmMessage[];
    assert.match(lastCall[0]!.content, /Withdraw funds using M-Pesa B2C/);
  } finally { await api.close(); }
});

test("uncovered question: zero confidence, escalate, empty citations, still recorded", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    const conv = await startConversation(api, { visitorId: "v-2" });
    const r = await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, {
      body: { message: "quibberflux vortistream blorptangle unknowable" },
    });
    const body = await json(r);
    assert.equal(body.confidence, 0);
    assert.equal(body.shouldEscalate, true);
    assert.deepEqual(body.citations, []);
    assert.equal(api.support.messages.get(conv)!.length, 2); // recorded regardless
  } finally { await api.close(); }
});

// ── TENANCY ────────────────────────────────────────────────────────────────────────────
test("per-brand KB: brand-B private chunk answers for brand B but never leaks to brand A", async () => {
  const api = await startTestApi();
  await api.support.seedKb([...SHARED_KB, ...BRANDB_KB]);
  try {
    // Brand B conversation (authed brand-B token) retrieves its private chunk.
    const convB = await startConversation(api, {}, `${TEST_USER}:player:${SITE_B}`);
    const rB = await json(await req(api, "POST", `/api/v1/support/conversations/${convB}/messages`, {
      token: `${TEST_USER}:player:${SITE_B}`, body: { message: "zephyrquux glimberton narwhalplex" },
    }));
    assert.ok(rB.citations.some((c: any) => c.source === "kb://brandb/secret"), "brand B sees its own chunk");

    // Same canary query in a brand-A conversation must NOT surface the brand-B chunk.
    const convA = await startConversation(api, { visitorId: "v-a" });
    const rA = await json(await req(api, "POST", `/api/v1/support/conversations/${convA}/messages`, {
      body: { message: "zephyrquux glimberton narwhalplex" },
    }));
    assert.ok(!rA.citations.some((c: any) => c.source === "kb://brandb/secret"), "brand A must not see brand B's KB");
  } finally { await api.close(); }
});

test("cross-brand posting is refused (authed brand-B token on a brand-A conversation)", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    const convA = await startConversation(api, { visitorId: "v-x" }); // anonymous -> brand A (default)
    const r = await req(api, "POST", `/api/v1/support/conversations/${convA}/messages`, {
      token: `${TEST_USER}:player:${SITE_B}`, body: { message: "hello" },
    });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error.code, "AUTH_SITE_MISMATCH");
  } finally { await api.close(); }
});

// ── attribution: anonymous vs authed ──────────────────────────────────────────────────────
test("attribution: anonymous carries visitorId+null user; authed carries userId+brand from token", async () => {
  const api = await startTestApi();
  try {
    const anon = await startConversation(api, { visitorId: "guest-42" });
    const ca = api.support.conversations.get(anon)!;
    assert.equal(ca.userId, null);
    assert.equal(ca.visitorId, "guest-42");
    assert.equal(ca.siteId, SITE_A);

    const authed = await startConversation(api, {}, `${TEST_USER}:player:${SITE_B}`);
    const cb = api.support.conversations.get(authed)!;
    assert.equal(cb.userId, TEST_USER);
    assert.equal(cb.siteId, SITE_B);
  } finally { await api.close(); }
});

// ── escalation ─────────────────────────────────────────────────────────────────────────
test("escalation: captures contact + flags conversation; validates input", async () => {
  const api = await startTestApi();
  try {
    const conv = await startConversation(api, { visitorId: "v-esc" });
    const ok = await req(api, "POST", `/api/v1/support/conversations/${conv}/escalate`, { body: { email: "player@example.com" } });
    assert.equal(ok.status, 200);
    const c = api.support.conversations.get(conv)!;
    assert.equal(c.escalated, true);
    assert.equal(c.status, "escalated");
    assert.equal(c.contactEmail, "player@example.com");

    assert.equal((await req(api, "POST", `/api/v1/support/conversations/${conv}/escalate`, { body: { email: "not-an-email" } })).status, 400);
    assert.equal((await req(api, "POST", `/api/v1/support/conversations/${conv}/escalate`, { body: {} })).status, 400);
  } finally { await api.close(); }
});

// ── RLS: operator reads ────────────────────────────────────────────────────────────────
test("operator reads: auth + admin role required; brand-scoped; superadmin sees all", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    // Two conversations in different brands.
    const convA = await startConversation(api, { visitorId: "a" });                          // brand A
    const convB = await startConversation(api, {}, `${TEST_USER}:player:${SITE_B}`);          // brand B

    // Unauthenticated -> 401; player -> 403.
    assert.equal((await req(api, "GET", "/api/v1/support/conversations")).status, 401);
    assert.equal((await req(api, "GET", "/api/v1/support/conversations", { token: PLAYER_A })).status, 403);

    // Site-A admin sees only brand-A conversations.
    const listA = await json(await req(api, "GET", "/api/v1/support/conversations", { token: ADMIN_A }));
    const idsA = listA.items.map((c: any) => c.id);
    assert.ok(idsA.includes(convA) && !idsA.includes(convB), "site-A admin scoped to brand A");

    // Site-B admin sees only brand-B conversations.
    const listB = await json(await req(api, "GET", "/api/v1/support/conversations", { token: ADMIN_B }));
    const idsB = listB.items.map((c: any) => c.id);
    assert.ok(idsB.includes(convB) && !idsB.includes(convA), "site-B admin scoped to brand B");

    // Platform superadmin sees both.
    const listAll = await json(await req(api, "GET", "/api/v1/support/conversations", { token: SUPERADMIN }));
    const idsAll = listAll.items.map((c: any) => c.id);
    assert.ok(idsAll.includes(convA) && idsAll.includes(convB), "superadmin sees all brands");

    // Detail read: site-A admin reading a brand-B conversation is hidden (404).
    assert.equal((await req(api, "GET", `/api/v1/support/conversations/${convB}`, { token: ADMIN_A })).status, 404);
    const detail = await json(await req(api, "GET", `/api/v1/support/conversations/${convA}`, { token: ADMIN_A }));
    assert.equal(detail.conversation.id, convA);
  } finally { await api.close(); }
});

// ── transport validation ─────────────────────────────────────────────────────────────────
test("validation: bad ids, missing/too-long message, unknown conversation, bad siteId", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    const conv = await startConversation(api, { visitorId: "v" });
    assert.equal((await req(api, "POST", "/api/v1/support/conversations/not-a-uuid/messages", { body: { message: "x" } })).status, 400);
    assert.equal((await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: {} })).status, 400);
    const long = "a".repeat(1001);
    assert.equal((await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: long } })).status, 400);
    const missing = "c0000000-0000-0000-0000-000000009999";
    assert.equal((await req(api, "POST", `/api/v1/support/conversations/${missing}/messages`, { body: { message: "hi" } })).status, 404);
    assert.equal((await req(api, "POST", "/api/v1/support/conversations", { body: { siteId: "nope" } })).status, 400);
  } finally { await api.close(); }
});

// ── multi-turn history reaches the model ──────────────────────────────────────────────────
test("history: prior turns are replayed into the LLM on the next question", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  try {
    const conv = await startConversation(api, { visitorId: "v-h" });
    await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: "first question about withdrawals" } });
    await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: "second question about affiliates" } });
    const lastCall = api.support.llmCalls.at(-1) as LlmMessage[];
    // system + prior(user+assistant) + new user
    assert.ok(lastCall.some((m) => m.role === "user" && /first question about withdrawals/.test(m.content)), "prior user turn replayed");
    assert.equal(lastCall.at(-1)!.content, "second question about affiliates");
  } finally { await api.close(); }
});

// ── resilience: the visitor turn survives an LLM failure ───────────────────────────────────
test("resilience: an LLM error still leaves the visitor turn recorded and returns 500", async () => {
  const api = await startTestApi();
  await api.support.seedKb(SHARED_KB);
  api.support.setLlm(async () => { throw new Error("provider down"); });
  try {
    const conv = await startConversation(api, { visitorId: "v-fail" });
    const r = await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: "will the model fail" } });
    assert.equal(r.status, 500);
    const rows = api.support.messages.get(conv)!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.role, "user"); // recorded before the model call
  } finally { await api.close(); }
});

// ── rate limiting ─────────────────────────────────────────────────────────────────────────
test("rate limiting: message posts beyond the per-ip window return 429", async () => {
  process.env.SUPPORT_MSG_LIMIT = "1";
  process.env.SUPPORT_MSG_WINDOW_MS = "10000";
  const api = await startTestApi(); // env is read at route registration
  await api.support.seedKb(SHARED_KB);
  try {
    const conv = await startConversation(api, { visitorId: "v-rl" });
    const first = await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: "one" } });
    assert.equal(first.status, 200);
    const second = await req(api, "POST", `/api/v1/support/conversations/${conv}/messages`, { body: { message: "two" } });
    assert.equal(second.status, 429);
  } finally {
    await api.close();
    delete process.env.SUPPORT_MSG_LIMIT;
    delete process.env.SUPPORT_MSG_WINDOW_MS;
  }
});
