import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripEmDashes,
  confidenceFromDistance,
  selectCitations,
  buildContextBlock,
  buildSystemPrompt,
  buildMessages,
  answerSupportQuestion,
  DEFAULT_SUPPORT_POLICY,
  type KbHit,
  type LlmMessage,
  type SupportBrandInfo,
  type SupportHistoryTurn,
} from "./support.js";

const BRAND: SupportBrandInfo = { name: "Invest254", supportEmail: "help@invest254.com", currency: "KES" };

function hit(source: string, heading: string | null, content: string, distance: number): KbHit {
  return { source, heading, content, distance };
}

// ── text hygiene ────────────────────────────────────────────────────────────────────────
test("stripEmDashes: removes em and en dashes, keeps hyphenated words", () => {
  assert.equal(stripEmDashes("deposit \u2014 then play"), "deposit, then play");
  assert.equal(stripEmDashes("range 10\u201320"), "range 10, 20");
  assert.equal(stripEmDashes("a - b"), "a, b");
  assert.equal(stripEmDashes("M-Pesa is fine"), "M-Pesa is fine"); // hyphenated word intact
  assert.equal(stripEmDashes("wait\u2026 done"), "wait... done");
  assert.ok(!/[\u2014\u2013]/.test(stripEmDashes("x \u2014 y \u2013 z")));
});

// ── confidence ──────────────────────────────────────────────────────────────────────────
test("confidenceFromDistance: monotone decreasing, clamped 0..1", () => {
  assert.equal(confidenceFromDistance(0), 1);
  assert.equal(confidenceFromDistance(null), 0);
  assert.equal(confidenceFromDistance(DEFAULT_SUPPORT_POLICY.maxUsefulDistance), 0);
  const a = confidenceFromDistance(0.1);
  const b = confidenceFromDistance(0.3);
  assert.ok(a > b && b > 0);
  assert.equal(confidenceFromDistance(5), 0); // beyond band -> 0
});

// ── citations ───────────────────────────────────────────────────────────────────────────
test("selectCitations: dedupes, drops weak hits, preserves order", () => {
  const hits = [
    hit("docs/08-payments-mpesa.md", "Deposits", "STK push", 0.10),
    hit("docs/08-payments-mpesa.md", "Deposits", "dup", 0.20), // dup source#heading
    hit("docs/09-affiliate-system.md", "Rev share", "20%", 0.30),
    hit("docs/99-noise.md", null, "irrelevant", 1.50),          // too weak -> dropped
  ];
  const cites = selectCitations(hits);
  assert.deepEqual(cites, [
    { source: "docs/08-payments-mpesa.md", heading: "Deposits" },
    { source: "docs/09-affiliate-system.md", heading: "Rev share" },
  ]);
});

// ── context + prompt ────────────────────────────────────────────────────────────────────
test("buildContextBlock: labels hits [n] and respects the char cap", () => {
  const hits = [hit("a.md", "H1", "alpha", 0.1), hit("b.md", null, "beta", 0.2)];
  const block = buildContextBlock(hits);
  assert.match(block, /\[1\] a\.md \(H1\)/);
  assert.match(block, /\[2\] b\.md/);
  const capped = buildContextBlock(hits, { ...DEFAULT_SUPPORT_POLICY, maxContextChars: 10 });
  assert.ok(capped.length <= 40); // only the first block fits
});

test("buildSystemPrompt: encodes brand, no-em-dash rule, and no-context fallback", () => {
  const p = buildSystemPrompt(BRAND, "[1] a.md\nfoo");
  assert.match(p, /Invest254/);
  assert.match(p, /help@invest254\.com/);
  assert.match(p, /Never use an em dash/);
  const none = buildSystemPrompt(BRAND, "");
  assert.match(none, /no relevant entries were found/);
});

test("buildMessages: system first, history trimmed to last 8 user/assistant, question last", () => {
  const history: SupportHistoryTurn[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  const msgs = buildMessages(BRAND, [hit("a.md", "H", "ctx", 0.1)], history, "How do I withdraw?");
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[msgs.length - 1]!.content, "How do I withdraw?");
  const convo = msgs.filter((m: LlmMessage) => m.role !== "system");
  assert.equal(convo.length, 8 + 1); // last 8 history + new question
});

// ── orchestrator ────────────────────────────────────────────────────────────────────────
function fakeEmbed(vec = [1, 0, 0]) {
  return async (texts: string[]) => texts.map(() => vec.slice());
}

test("answerSupportQuestion: grounded path returns citations, high confidence, no escalation, no em dash", async () => {
  const hits = [hit("docs/08-payments-mpesa.md", "Withdrawals", "Withdraw via M-Pesa B2C from your wallet.", 0.08)];
  const ans = await answerSupportQuestion(
    {
      embed: fakeEmbed(),
      searchKb: async () => hits,
      llm: async (msgs) => `Based on ${(msgs[0]!.content.length > 0)}, you withdraw via M-Pesa \u2014 B2C.`,
    },
    { siteId: "s1", question: "How do I withdraw?", brand: BRAND },
  );
  assert.ok(ans.confidence > 0.8, `confidence ${ans.confidence}`);
  assert.equal(ans.shouldEscalate, false);
  assert.deepEqual(ans.citations, [{ source: "docs/08-payments-mpesa.md", heading: "Withdrawals" }]);
  assert.ok(!/[\u2014\u2013]/.test(ans.answer), "answer must contain no em dash");
});

test("answerSupportQuestion: no relevant hits -> zero confidence, escalate, empty citations", async () => {
  const ans = await answerSupportQuestion(
    {
      embed: fakeEmbed(),
      searchKb: async () => [hit("docs/99.md", null, "unrelated", 1.9)], // beyond band
      llm: async () => "I am not certain about that.",
    },
    { siteId: "s1", question: "What is the meaning of life?", brand: BRAND },
  );
  assert.equal(ans.confidence, 0);
  assert.equal(ans.shouldEscalate, true);
  assert.deepEqual(ans.citations, []);
});

test("answerSupportQuestion: rejects empty question and empty embedding", async () => {
  await assert.rejects(
    () => answerSupportQuestion({ embed: fakeEmbed(), searchKb: async () => [], llm: async () => "x" },
      { siteId: "s1", question: "   ", brand: BRAND }),
    /EMPTY_QUESTION/,
  );
  await assert.rejects(
    () => answerSupportQuestion({ embed: async () => [[]], searchKb: async () => [], llm: async () => "x" },
      { siteId: "s1", question: "hi", brand: BRAND }),
    /EMBED_FAILED/,
  );
});

test("answerSupportQuestion: passes the retrieved context into the LLM prompt (grounding)", async () => {
  let seen: LlmMessage[] = [];
  await answerSupportQuestion(
    {
      embed: fakeEmbed(),
      searchKb: async () => [hit("docs/02-game-engine.md", "RTP", "The house edge is configurable per game.", 0.12)],
      llm: async (msgs) => { seen = msgs; return "ok"; },
    },
    { siteId: "s1", question: "How is RTP set?", brand: BRAND },
  );
  assert.match(seen[0]!.content, /house edge is configurable/); // KB content reached the model
});
