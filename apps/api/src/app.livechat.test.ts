import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";
import { InMemoryLiveChatStore, signMedia, verifyMedia } from "./app.livechat.js";

/** CHAT-1 — live chat API: who may read/write which thread, attachments, unread, resolve, media links. */
const SITE_B = "00000000-0000-0000-0000-00000000000b";
const P1 = `p1:player:${SITE_A}`;
const P2 = `p2:player:${SITE_A}`;
const PB = `pb:player:${SITE_B}`;
const ADMIN_A = `adm:admin:${SITE_A}`;
const ADMIN_B = `admb:admin:${SITE_B}`;
const OWNER = "own:platform_superadmin";
const PA = `pa:platform_admin:${SITE_A}:10000000-0000-0000-0000-000000000001`;
const SECRET = "test-media-secret";

async function call(api: TestApi, method: string, path: string, token: string | null, body?: unknown, raw?: { type: string; data: Buffer }) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (raw) { headers["content-type"] = raw.type; init.body = raw.data; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const ct = r.headers.get("content-type") ?? "";
  const j = ct.includes("json") ? ((await r.json().catch(() => ({}))) as any) : null;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined, message: j?.error?.message as string | undefined, headers: r.headers, bytes: j ? null : Buffer.from(await r.arrayBuffer()) };
}

test("CHAT-1 API: a player chats, attaches, agents of the SAME brand answer; other brands see nothing", async () => {
  const store = new InMemoryLiveChatStore();
  store.users.set("p1", { siteId: SITE_A, username: "alice" });
  store.users.set("pb", { siteId: SITE_B, username: "bob" });
  store.contactsBySite.set(SITE_A, { email: "help@a.test", whatsapp: "+254700000001", brandName: "Alpha" });
  const api = await startTestApi({ depsOverrides: { liveChat: { store, mediaSecret: SECRET } } });
  try {
    // empty state + contacts
    let me = await call(api, "GET", "/chat", P1);
    assert.equal(me.status, 200); assert.equal(me.body.thread, null); assert.equal(me.body.contacts.whatsapp, "+254700000001");
    assert.equal((await call(api, "GET", "/chat", null)).status, 401);
    assert.equal((await call(api, "GET", "/chat", ADMIN_A)).code, "CUSTOMERS_ONLY", "operators answer from the back office");
    assert.equal((await call(api, "POST", "/chat/messages", P1, { body: "   " })).code, "EMPTY_MESSAGE");

    // first message opens a thread
    const sent = await call(api, "POST", "/chat/messages", P1, { body: "My deposit is missing" });
    assert.equal(sent.status, 201);
    const threadId = sent.body.threadId as string;

    // attachments: type + size enforced, then a photo
    assert.equal((await call(api, "POST", "/chat/attachments", P1, undefined, { type: "application/pdf", data: Buffer.from("x") })).code, "UNSUPPORTED_FILE");
    assert.equal((await call(api, "POST", "/chat/attachments", P1, undefined, { type: "image/png", data: Buffer.alloc(5 * 1024 * 1024 + 1) })).code, "FILE_TOO_LARGE");
    const up = await call(api, "POST", "/chat/attachments", P1, undefined, { type: "image/png", data: Buffer.from([137, 80, 78, 71, 1, 2, 3]) });
    assert.equal(up.status, 201);
    await call(api, "POST", "/chat/messages", P1, { body: "", attachmentId: up.body.id });

    // another player cannot use that attachment or see the thread
    assert.equal((await call(api, "POST", "/chat/messages", P2, { body: "", attachmentId: up.body.id })).code, "ATTACHMENT_NOT_FOUND");
    assert.equal((await call(api, "GET", "/chat", P2)).body.messages.length, 0, "P2 sees nothing of P1's conversation");

    // agents: same brand sees it with 2 unread; another brand does not; raw platform admins are refused
    const inboxA = await call(api, "GET", "/admin/chat/threads", ADMIN_A);
    assert.equal(inboxA.body.items.length, 1); assert.equal(inboxA.body.items[0].agentUnread, 2);
    assert.equal((await call(api, "GET", "/admin/chat/unread", ADMIN_A)).body.count, 2);
    assert.equal((await call(api, "GET", "/admin/chat/threads", ADMIN_B)).body.items.length, 0);
    assert.equal((await call(api, "GET", `/admin/chat/threads/${threadId}`, ADMIN_B)).status, 404);
    assert.equal((await call(api, "POST", `/admin/chat/threads/${threadId}/messages`, ADMIN_B, { body: "hi" })).status, 404);
    assert.equal((await call(api, "GET", "/admin/chat/threads", PA)).status, 403);
    assert.equal((await call(api, "GET", "/admin/chat/threads", OWNER)).body.items.length, 1, "the System owner sees every brand");

    // the agent reads (clears unread), replies; the player sees "Support", never the agent's name
    const th = await call(api, "GET", `/admin/chat/threads/${threadId}`, ADMIN_A);
    assert.equal(th.body.messages.length, 2);
    const photo = th.body.messages[1].attachment;
    assert.equal(photo.kind, "image"); assert.match(photo.url, /^\/api\/v1\/chat\/media\/.+\?t=/);
    await call(api, "POST", `/admin/chat/threads/${threadId}/read`, ADMIN_A);
    assert.equal((await call(api, "GET", "/admin/chat/unread", ADMIN_A)).body.count, 0);
    assert.equal((await call(api, "POST", `/admin/chat/threads/${threadId}/messages`, ADMIN_A, { body: "We are checking it now." })).status, 201);
    me = await call(api, "GET", "/chat", P1);
    assert.equal(me.body.thread.playerUnread, 1);
    const reply = me.body.messages.at(-1);
    assert.equal(reply.authorRole, "agent"); assert.equal(reply.authorName, "Support");
    const polled = await call(api, "GET", `/chat/messages?after=${me.body.messages[1].id}`, P1);
    assert.equal(polled.body.messages.length, 1, "polling returns only newer messages");
    await call(api, "POST", "/chat/read", P1);
    assert.equal((await call(api, "GET", "/chat", P1)).body.thread.playerUnread, 0);

    // media: signed link works without a bearer; a bad/expired token is a 404
    const media = await call(api, "GET", photo.url.replace("/api/v1", ""), null);
    assert.equal(media.status, 200); assert.equal(media.headers.get("content-type"), "image/png"); assert.equal(media.bytes!.length, 7);
    assert.equal((await call(api, "GET", `/chat/media/${up.body.id}?t=1.bad`, null)).status, 404);
    assert.equal(verifyMedia(SECRET, up.body.id, signMedia(SECRET, up.body.id, Date.now() - 2 * 3600_000)), false, "links expire");

    // resolve; a new player message starts a fresh thread
    assert.equal((await call(api, "POST", `/admin/chat/threads/${threadId}/status`, ADMIN_A, { status: "closed" })).code, "INVALID_STATUS");
    await call(api, "POST", `/admin/chat/threads/${threadId}/status`, ADMIN_A, { status: "resolved" });
    assert.equal((await call(api, "GET", "/admin/chat/threads", ADMIN_A)).body.items.length, 0, "resolved leaves the Open list");
    assert.equal((await call(api, "GET", "/admin/chat/threads?status=resolved", ADMIN_A)).body.items.length, 1);
    const again = await call(api, "POST", "/chat/messages", P1, { body: "Thanks, one more thing" });
    assert.notEqual(again.body.threadId, threadId);

    // brand isolation for players too: a brand-B player cannot open a thread on brand A's scope
    assert.equal((await call(api, "POST", "/chat/messages", `pb:player:${SITE_A}`, { body: "x" })).code, "NOT_YOUR_BRAND");
    assert.equal((await call(api, "POST", "/chat/messages", PB, { body: "hello B" })).status, 201);
    assert.equal((await call(api, "GET", "/admin/chat/threads", ADMIN_A)).body.items.every((t: any) => t.siteId === SITE_A), true);
  } finally { await api.close(); }
});
