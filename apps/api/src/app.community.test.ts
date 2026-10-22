import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A, SITE_B, TEST_ADMIN, TEST_USER } from "./testutil.js";
import type { CommunityPost, CommunityStore, PollOption } from "./community.pg.js";

/**
 * The per-brand community channel (migration 0192).
 *
 * The three things worth breaking a build over are not the happy paths:
 *   1. It is a CHANNEL, not a group. There is no player composer, so a player must be refused on
 *      every write — posting, pinning, closing, deleting.
 *   2. One player is one vote, keyed (post_id, user_id). Voting again CHANGES the answer, so the
 *      counts stay counts of PEOPLE rather than of clicks.
 *   3. Voting refuses when the option is not on this post, when the post is not this brand's, or
 *      when the poll is closed — a smuggled option id from another brand's post must match nothing.
 *      That is the security-relevant line in the whole feature.
 *
 * The test app wires no Postgres community store, so these drive the routes against an in-memory
 * fake that enforces the SAME rules the statements do. What that proves is ROUTE behaviour: that
 * the brand the token is scoped to is the brand handed to the store, that a refusal comes back as a
 * code an operator can read rather than a 500, and that the admin gate sits where it should. The
 * SQL itself (the single-statement insert ... select ... on conflict) is not under test here — see
 * the comment on the fake's `vote` for exactly which part is mimicked rather than exercised.
 */

interface FakeRow {
  id: string;
  siteId: string;
  kind: "post" | "poll" | "live";
  title: string | null;
  body: string;
  streamUrl: string | null;
  pinned: boolean;
  closed: boolean;
  createdAt: number;
  author: string;
  options: Array<{ id: string; label: string }>;
}

/**
 * An in-memory CommunityStore that honours the rules the real statements enforce: every read and
 * write is filtered by site id, a vote is keyed by (post, user) so re-voting replaces, and a vote is
 * refused unless the option's own post is this post, in this brand, a poll, and open.
 *
 * It also records the (op, siteId) of every call, because "the route passed the token's brand down"
 * is an assertion the response body alone cannot make.
 */
function fakeCommunity() {
  const rows: FakeRow[] = [];
  /** `${postId}|${userId}` -> optionId. The composite key IS the one-vote-per-player rule. */
  const votes = new Map<string, string>();
  const calls: Array<{ op: string; siteId: string }> = [];
  let seq = 0;

  const optionsOf = (r: FakeRow): PollOption[] =>
    r.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: [...votes.entries()].filter(([k, v]) => k.startsWith(`${r.id}|`) && v === o.id).length,
    }));

  const view = (r: FakeRow, viewerId: string | null): CommunityPost => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    streamUrl: r.streamUrl,
    pinned: r.pinned,
    closed: r.closed,
    createdAt: new Date(r.createdAt).toISOString(),
    author: r.author,
    options: optionsOf(r),
    myVote: viewerId ? votes.get(`${r.id}|${viewerId}`) ?? null : null,
    totalVotes: [...votes.keys()].filter((k) => k.startsWith(`${r.id}|`)).length,
  });

  /** Seeds a row directly, so a test can set up another brand's poll without an admin token. */
  function seed(p: Partial<FakeRow> & { siteId: string }): FakeRow {
    const id = `p${++seq}`;
    const row: FakeRow = {
      id, kind: "post", title: null, body: "seeded", streamUrl: null, pinned: false, closed: false,
      createdAt: ++seq, author: "Admin", options: [], ...p,
    };
    row.id = id;
    rows.push(row);
    return row;
  }
  /** A poll with labelled options, whose option ids are what a cross-brand attack would smuggle. */
  function seedPoll(siteId: string, labels: string[], extra: Partial<FakeRow> = {}): FakeRow {
    const row = seed({ siteId, kind: "poll", body: "pick one", ...extra });
    row.options = labels.map((label, i) => ({ id: `${row.id}-o${i}`, label }));
    return row;
  }

  const store: CommunityStore = {
    async list(siteId, viewerId, limit) {
      calls.push({ op: `list:${limit}`, siteId });
      return rows
        .filter((r) => r.siteId === siteId)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((r) => view(r, viewerId));
    },

    async post(siteId, authorId, input) {
      calls.push({ op: "post", siteId });
      const kind = input.kind === "poll" ? "poll" : "post";
      const opts = (input.options ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (kind === "poll" && opts.length < 2) throw new Error("POLL_NEEDS_OPTIONS");
      const row = seed({
        siteId, kind, body: input.body, pinned: input.pinned === true,
        title: input.title?.trim() ? input.title : null, author: authorId,
      });
      row.options = opts.map((label, i) => ({ id: `${row.id}-o${i}`, label }));
      return view(row, null);
    },

    async vote(siteId, postId, userId, optionId) {
      calls.push({ op: "vote", siteId });
      /**
       * Mirrors the WHERE of the real insert ... select: the option is looked up on its OWN post
       * first, exactly as `o.id = $4` does, so an id borrowed from somewhere else resolves and is
       * then rejected by the post/site/kind/open checks rather than merely "not found". The real
       * statement does this and the upsert in one round trip and under one lock; that atomicity is
       * the part a fake cannot reproduce, so a concurrent double-vote is not what this asserts.
       */
      const owner = rows.find((r) => r.options.some((o) => o.id === optionId));
      const target = rows.find((r) => r.id === postId);
      if (!owner || !target || owner.id !== target.id) throw new Error("VOTE_REFUSED");
      if (target.siteId !== siteId || target.kind !== "poll" || target.closed) throw new Error("VOTE_REFUSED");
      votes.set(`${postId}|${userId}`, optionId); // replaces, never appends — the composite key
      return view(target, userId);
    },

    async setClosed(siteId, postId, closed) {
      calls.push({ op: "setClosed", siteId });
      const r = rows.find((x) => x.id === postId && x.siteId === siteId);
      if (r) r.closed = closed;
    },

    async setPinned(siteId, postId, pinned) {
      calls.push({ op: "setPinned", siteId });
      const r = rows.find((x) => x.id === postId && x.siteId === siteId);
      if (r) r.pinned = pinned;
    },

    async remove(siteId, postId) {
      calls.push({ op: "remove", siteId });
      const i = rows.findIndex((x) => x.id === postId && x.siteId === siteId);
      if (i >= 0) rows.splice(i, 1);
    },

    async announceLive(siteId, authorId, streamUrl, brandName) {
      calls.push({ op: "announceLive", siteId });
      for (const r of rows) if (r.siteId === siteId && r.kind === "live") r.pinned = false;
      const row = seed({
        siteId, kind: "live", title: `${brandName} is live now`, body: "We are trading live.",
        streamUrl, pinned: true, author: authorId,
      });
      return view(row, null);
    },
  };

  return { store, rows, votes, calls, seed, seedPoll };
}

// Tokens are `<userId>[:<role>[:<siteId>]]` (stubVerifier). No site segment -> requireSite's default
// brand, which is SITE_A, so these two admins are genuinely admins of different brands.
const PLAYER_A = TEST_USER;
const PLAYER_A2 = "u-player-2";
const ADMIN_A = `${TEST_ADMIN}:admin`;
const ADMIN_B = `u-admin-b:admin:${SITE_B}`;

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${api.baseUrl}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("community: a signed-in player reads only their own brand's channel, pinned first, with their own vote on it", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    fake.seed({ siteId: SITE_A, body: "ours" });
    fake.seed({ siteId: SITE_A, body: "ours, pinned", pinned: true });
    fake.seed({ siteId: SITE_B, body: "the other brand's" });

    assert.equal((await req(api, "GET", "/api/v1/community")).status, 401, "the channel is not public");

    const res = await req(api, "GET", "/api/v1/community", PLAYER_A);
    assert.equal(res.status, 200, "reading is for any signed-in player — this is the one open route");
    const items = (await json(res)).items as CommunityPost[];
    // The other brand's post must be absent even though it sits in the same store: the token's
    // brand, not the request, decides what is readable.
    assert.deepEqual(items.map((i) => i.body), ["ours, pinned", "ours"]);
    assert.equal(fake.calls.at(-1)?.siteId, SITE_A, "the store is handed the token's brand");

    // The viewer's own vote rides on the feed, which is what lets a client show a chosen option.
    const poll = fake.seedPoll(SITE_A, ["yes", "no"]);
    await req(api, "POST", `/api/v1/community/${poll.id}/vote`, PLAYER_A, { optionId: poll.options[1]!.id });
    const after = ((await json(await req(api, "GET", "/api/v1/community", PLAYER_A))).items as CommunityPost[])
      .find((i) => i.id === poll.id)!;
    assert.equal(after.myVote, poll.options[1]!.id, "the reader sees their OWN answer");
    const asOther = ((await json(await req(api, "GET", "/api/v1/community", PLAYER_A2))).items as CommunityPost[])
      .find((i) => i.id === poll.id)!;
    assert.equal(asOther.myVote, null, "and nobody else's");
  } finally { await api.close(); }
});

test("community: the feed limit is clamped, so a client cannot ask for the whole table", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    // MAX_POSTS is 50 and the default is 30. A hostile or careless `limit` must not become the
    // store's limit, because that limit is the only thing bounding the query.
    for (const [q, want] of [["", 30], ["?limit=5", 5], ["?limit=9999", 50], ["?limit=0", 30], ["?limit=-7", 30], ["?limit=abc", 30]] as const) {
      await req(api, "GET", `/api/v1/community${q}`, PLAYER_A);
      assert.equal(fake.calls.at(-1)?.op, `list:${want}`, `limit${q || " (absent)"} -> ${want}`);
    }
  } finally { await api.close(); }
});

/**
 * `POST /community` and `POST /community/:id/vote` answer with the POST ITSELF.
 *
 * This is worth asserting rather than assuming, because for a while they did not. Both handlers
 * return a `CommunityPost`, and the Router used to treat any object with a `body` property as its
 * `{ status?, body }` envelope — and a post HAS a `body`. So the whole object collapsed to that one
 * string: a vote answered `"pick one"` instead of the updated poll, with no id, no options and no
 * counts, which is exactly what `CommunityFeed` needs to redraw the tally from the server's answer.
 * `isEnvelope` in `http.ts` now requires that `body` and `status` are the object's ONLY keys, so a
 * DTO of its own passes straight through. These assertions are what would fail if that narrowing
 * were ever reverted.
 */
const postBody = async (res: Response): Promise<any> => (await json(res)) as any;

test("community: one player is one vote — voting again changes the answer instead of stuffing the ballot", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    const poll = fake.seedPoll(SITE_A, ["red", "blue"]);
    const red = poll.options[0]!, blue = poll.options[1]!;
    const counts = () => poll.options.map((o) => [...fake.votes.values()].filter((v) => v === o.id).length);

    const first = await req(api, "POST", `/api/v1/community/${poll.id}/vote`, PLAYER_A, { optionId: red.id });
    assert.equal(first.status, 200);
    // The whole poll comes back, not just its body text: the client redraws the tally from THIS.
    const voted = await postBody(first);
    assert.equal(voted.id, poll.id, "the vote answers with the post, not with the post's body string");
    assert.equal(voted.body, "pick one");
    assert.equal(voted.myVote, red.id, "and it carries the voter's own choice");
    assert.equal(voted.options.length, 2, "and the options, which a bare string could never carry");
    assert.deepEqual(counts(), [1, 0]);

    const changed = await req(api, "POST", `/api/v1/community/${poll.id}/vote`, PLAYER_A, { optionId: blue.id });
    assert.equal(changed.status, 200, "changing your mind is allowed, not a conflict");
    // The point of the (post_id, user_id) primary key: the same person voting twice is still one
    // vote, and it has MOVED. A second row here would make every poll count clicks.
    assert.equal(fake.votes.size, 1, "the same player did not add a vote");
    assert.deepEqual(counts(), [0, 1], "their vote moved to the new option");
    assert.equal(fake.votes.get(`${poll.id}|${PLAYER_A}`), blue.id);

    assert.equal((await req(api, "POST", `/api/v1/community/${poll.id}/vote`, PLAYER_A2, { optionId: blue.id })).status, 200);
    assert.equal(fake.votes.size, 2, "a different player does add one — two people, two rows");
    assert.deepEqual(counts(), [0, 2], "so the tally counts PEOPLE, which is the whole claim");

    // A missing or non-string optionId is a client bug, answered as such rather than reaching SQL.
    for (const body of [{}, { optionId: "" }, { optionId: 7 }]) {
      const bad = await req(api, "POST", `/api/v1/community/${poll.id}/vote`, PLAYER_A, body);
      assert.equal(bad.status, 400);
      assert.equal((await json(bad)).error.code, "VALIDATION");
    }
  } finally { await api.close(); }
});

test("community: a vote is refused for an option that is not on this post, a post from another brand, or a closed poll", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    const ours = fake.seedPoll(SITE_A, ["a", "b"]);
    const alsoOurs = fake.seedPoll(SITE_A, ["c", "d"]);
    const theirs = fake.seedPoll(SITE_B, ["x", "y"]);
    const closed = fake.seedPoll(SITE_A, ["e", "f"], { closed: true });
    const notAPoll = fake.seed({ siteId: SITE_A, kind: "post", body: "just a note" });

    const refused = async (postId: string, optionId: string, why: string) => {
      const res = await req(api, "POST", `/api/v1/community/${postId}/vote`, PLAYER_A, { optionId });
      // A refusal is a 409 with a code an operator can read in a log, never a 500 — the statement
      // declining to match rows is an expected outcome, not a fault.
      assert.equal(res.status, 409, why);
      assert.equal((await json(res)).error.code, "VOTE_REFUSED", why);
    };

    // THE one that matters: an option id lifted from another brand's poll, posted against a post of
    // our own. Both ids exist; the join still matches nothing, so no vote lands anywhere.
    await refused(ours.id, theirs.options[0]!.id, "an option smuggled in from another brand's poll");
    await refused(theirs.id, theirs.options[0]!.id, "another brand's post is not ours to vote on");
    await refused(ours.id, alsoOurs.options[0]!.id, "an option from a different poll of our own brand");
    await refused(closed.id, closed.options[0]!.id, "a closed poll takes no more votes");
    await refused(notAPoll.id, ours.options[0]!.id, "an ordinary post is not a ballot");
    await refused("no-such-post", ours.options[0]!.id, "an unknown post id");
    await refused(ours.id, "no-such-option", "an unknown option id");

    assert.equal(fake.votes.size, 0, "not one of those refusals left a vote behind");
    // And the brand that reached the store was always the token's, never the body's or the path's.
    for (const c of fake.calls) assert.equal(c.siteId, SITE_A, `${c.op} ran as the caller's brand`);
  } finally { await api.close(); }
});

test("community: a player cannot write — no composer, no pin, no close, no delete", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    const post = fake.seed({ siteId: SITE_A, body: "admin's own" });
    fake.calls.length = 0;

    // This is the shape of the feature, not a permission detail: a brand channel carrying an
    // unmoderated player conversation is the support and compliance surface 0192 refuses to open.
    const writes: Array<[string, unknown]> = [
      ["/api/v1/community", { body: "let me in" }],
      [`/api/v1/community/${post.id}/pin`, { pinned: true }],
      [`/api/v1/community/${post.id}/close`, { closed: true }],
      [`/api/v1/community/${post.id}/delete`, {}],
    ];
    for (const [path, body] of writes) {
      const res = await req(api, "POST", path, PLAYER_A, body);
      assert.equal(res.status, 403, `${path} is admin-only`);
      assert.equal((await req(api, "POST", path)).status, 401, `${path} needs a token at all`);
    }
    // A marketer is a player with a payout, not an operator, so the same wall applies.
    assert.equal((await req(api, "POST", "/api/v1/community", `${PLAYER_A}:marketer`, { body: "hi" })).status, 403);

    assert.equal(fake.calls.length, 0, "the gate turned them away before the store was touched");
    assert.equal(fake.rows.length, 1, "and nothing was written");
  } finally { await api.close(); }
});

test("community: an admin posts notes and polls, and a malformed one is rejected with a reason", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    // The created post is read back from the store, not from the response: the envelope collision
    // noted above leaves the response as the body string alone.
    const created = await req(api, "POST", "/api/v1/community", ADMIN_A, {
      title: "Maintenance", body: "  We are upgrading tonight.  ", pinned: true,
    });
    assert.equal(created.status, 200);
    const post = await postBody(created);
    assert.equal(post.body, "We are upgrading tonight.");
    assert.equal(typeof post.id, "string", "the created post's id comes back, so a client can act on it");
    assert.equal(post.kind, "post");
    const note = fake.rows.at(-1)!;
    assert.equal(note.kind, "post", "no `kind` means an ordinary note");
    assert.equal(note.body, "We are upgrading tonight.", "the body is trimmed before it is stored");
    assert.equal(note.pinned, true);
    assert.equal(note.author, TEST_ADMIN, "authored by the caller, not by whatever the body claimed");
    assert.equal(note.siteId, SITE_A, "and filed under the admin's own brand");

    await req(api, "POST", "/api/v1/community", ADMIN_A, {
      kind: "poll", body: "Which market next?", options: ["Forex", "Crypto", 42, "  "],
    });
    const poll = fake.rows.at(-1)!;
    assert.equal(poll.kind, "poll");
    // Non-strings and blanks are dropped rather than becoming options labelled "42" or " ".
    assert.deepEqual(poll.options.map((o) => o.label), ["Forex", "Crypto"]);

    for (const [body, code, why] of [
      [{ body: "" }, "VALIDATION", "an empty body"],
      [{ body: "   " }, "VALIDATION", "a whitespace-only body"],
      [{}, "VALIDATION", "no body at all"],
      [{ kind: "poll", body: "One choice?", options: ["only"] }, "VALIDATION", "a poll with one option is not a poll"],
      [{ kind: "poll", body: "No choices?" }, "VALIDATION", "a poll with no options"],
    ] as const) {
      const res = await req(api, "POST", "/api/v1/community", ADMIN_A, body);
      assert.equal(res.status, 400, why);
      assert.equal((await json(res)).error.code, code, why);
    }
    // An unknown `kind` falls back to a plain post instead of reaching the kind check constraint.
    await req(api, "POST", "/api/v1/community", ADMIN_A, { kind: "live", body: "nice try" });
    assert.equal(fake.rows.at(-1)!.kind, "post", "a client cannot mint the automatic live card through the composer");
  } finally { await api.close(); }
});

test("community: pin, close and delete act only within the admin's own brand", async () => {
  const fake = fakeCommunity();
  const api = await startTestApi({ depsOverrides: { community: fake.store } });
  try {
    const ours = fake.seedPoll(SITE_A, ["a", "b"]);
    const theirs = fake.seedPoll(SITE_B, ["x", "y"]);

    assert.equal((await req(api, "POST", `/api/v1/community/${ours.id}/pin`, ADMIN_A, {})).status, 200);
    assert.equal(ours.pinned, true, "an absent `pinned` pins — the route's default is the useful one");
    await req(api, "POST", `/api/v1/community/${ours.id}/pin`, ADMIN_A, { pinned: false });
    assert.equal(ours.pinned, false, "and `false` unpins");

    await req(api, "POST", `/api/v1/community/${ours.id}/close`, ADMIN_A, {});
    assert.equal(ours.closed, true, "closing stops the voting while the post stays readable");
    assert.equal(
      (await req(api, "POST", `/api/v1/community/${ours.id}/vote`, PLAYER_A, { optionId: ours.options[0]!.id })).status,
      409, "a closed poll refuses the next vote",
    );
    await req(api, "POST", `/api/v1/community/${ours.id}/close`, ADMIN_A, { closed: false });
    assert.equal(ours.closed, false, "and re-opening is possible — closing is not destruction");

    // Brand A's admin naming brand B's post. The statements filter by site_id, so the call is a
    // no-op rather than an error; what must never happen is the other brand's row changing. An
    // admin of B reaching their own row proves the id was right and the brand was the only barrier.
    for (const op of ["pin", "close", "delete"]) {
      assert.equal((await req(api, "POST", `/api/v1/community/${theirs.id}/${op}`, ADMIN_A, {})).status, 200);
    }
    assert.equal(theirs.pinned, false, "cross-brand pin did nothing");
    assert.equal(theirs.closed, false, "cross-brand close did nothing");
    assert.ok(fake.rows.includes(theirs), "cross-brand delete did nothing");
    for (const c of fake.calls) assert.notEqual(c.siteId, SITE_B, "brand A's token never acts as brand B");

    assert.equal((await req(api, "POST", `/api/v1/community/${theirs.id}/delete`, ADMIN_B, {})).status, 200);
    assert.ok(!fake.rows.includes(theirs), "its own brand's admin can delete it");

    await req(api, "POST", `/api/v1/community/${ours.id}/delete`, ADMIN_A, {});
    assert.ok(!fake.rows.includes(ours));
    // Deleting the same post twice is still 200: the delete is idempotent because `delete ... where`
    // matching nothing is not a failure, and a retried request must not look like an error.
    assert.equal((await req(api, "POST", `/api/v1/community/${ours.id}/delete`, ADMIN_A, {})).status, 200);
  } finally { await api.close(); }
});

test("community: with no store wired the routes decline politely instead of crashing", async () => {
  // `community` is optional on ApiDeps, so a deployment that never wired it must keep serving every
  // other route. The channel answers 501 NOT_AVAILABLE — a deliberate "this build does not have
  // that" rather than the 500 an undefined store would produce.
  const bare = await startTestApi();
  try {
    for (const [method, path, token] of [
      ["GET", "/api/v1/community", PLAYER_A],
      ["POST", "/api/v1/community/p1/vote", PLAYER_A],
      ["POST", "/api/v1/community", ADMIN_A],
      ["POST", "/api/v1/community/p1/pin", ADMIN_A],
      ["POST", "/api/v1/community/p1/close", ADMIN_A],
      ["POST", "/api/v1/community/p1/delete", ADMIN_A],
    ] as const) {
      const res = await req(bare, method, path, token, method === "POST" ? { body: "x", optionId: "o" } : undefined);
      assert.equal(res.status, 501, `${method} ${path}`);
      assert.equal((await json(res)).error.code, "NOT_AVAILABLE", `${method} ${path}`);
    }
    // The gate still runs first: an unavailable store is not a way around the admin check.
    assert.equal((await req(bare, "POST", "/api/v1/community", PLAYER_A, { body: "x" })).status, 403);
  } finally { await bare.close(); }
});
