/**
 * Support assistant core (docs/11 chat, backend migration 0057). Pure and deterministic:
 * given a knowledge-base retriever, an embedder, and an LLM (all injected as ports), it
 * turns a visitor question into a GROUNDED answer plus citations, a confidence score, and
 * an escalation decision. All correctness that does NOT need the network lives here so it
 * is unit-testable; `apps/api/src/app.support.ts` only adds transport + recording.
 *
 * Design goals (from the product brief):
 *   - 100% natural language, ZERO em dashes in anything we send to a visitor.
 *   - Answer ONLY from the retrieved knowledge base; when the KB does not cover a question,
 *     say so plainly and offer to escalate to a human (never invent facts).
 *   - Every answer carries the sources it was grounded on, for the operator transcript.
 */

// ── Retrieval + message types ──────────────────────────────────────────────────────────
export interface KbHit {
  source: string;            // e.g. "docs/08-payments-mpesa.md"
  heading: string | null;    // nearest heading, for citation
  content: string;           // chunk text
  distance: number;          // cosine distance (0 = identical, 2 = opposite)
}

export type SupportRole = "user" | "assistant" | "system";
export interface SupportHistoryTurn { role: SupportRole; content: string; }
export interface SupportCitation { source: string; heading: string | null; }

/** Minimal brand facts the prompt personalises with (sourced from the `sites` row). */
export interface SupportBrandInfo { name: string; supportEmail?: string | null; currency?: string; }

// ── Injected ports ─────────────────────────────────────────────────────────────────────
/** Query-time embedder. MUST be the same model family used at ingest (bge-small, 384-dim). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface LlmMessage { role: "system" | "user" | "assistant"; content: string; }
/** Free chat-completion LLM. Returns the assistant text for the given messages. */
export type LlmFn = (messages: LlmMessage[], opts?: { maxTokens?: number; temperature?: number }) => Promise<string>;

/** Top-k KB retrieval for a brand (shared KB + that brand's overrides). */
export type SearchKbFn = (siteId: string, embedding: number[], k: number) => Promise<KbHit[]>;

// ── Policy ───────────────────────────────────────────────────────────────────────────────
export interface SupportPolicy {
  /** How many chunks to retrieve and feed the model. */
  topK: number;
  /** A hit whose cosine distance exceeds this is too weak to cite or ground on. */
  maxUsefulDistance: number;
  /** Confidence below this suggests escalation to a human. */
  escalateBelowConfidence: number;
  /** Hard cap on characters of KB context injected into the prompt. */
  maxContextChars: number;
}

export const DEFAULT_SUPPORT_POLICY: SupportPolicy = {
  topK: 5,
  maxUsefulDistance: 0.62,
  escalateBelowConfidence: 0.35,
  maxContextChars: 6000,
};

// ── Text hygiene ───────────────────────────────────────────────────────────────────────
/**
 * Remove em dashes and their typographic cousins from anything shown to a visitor. Em/en
 * dashes become a comma+space when they sit between words, else a plain space; a spaced
 * hyphen "word - word" is normalised to a comma too. Also collapses the resulting spaces.
 */
export function stripEmDashes(input: string): string {
  let s = String(input ?? "");
  // Em dash and en dash (with optional surrounding spaces) -> ", "
  s = s.replace(/\s*[\u2014\u2013]\s*/g, ", ");
  // A spaced ASCII hyphen used as a dash "a - b" -> "a, b" (leave hyphenated-words intact).
  s = s.replace(/\s+-\s+/g, ", ");
  // Horizontal ellipsis -> three dots.
  s = s.replace(/\u2026/g, "...");
  // Tidy any doubled punctuation/space the substitutions may have produced.
  s = s.replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1");
  return s.trim();
}

/**
 * Map a best-hit cosine distance to a 0..1 confidence. distance 0 -> 1.0, and it falls to
 * 0 as the best hit reaches `maxUsefulDistance`. No hits -> 0.
 */
export function confidenceFromDistance(bestDistance: number | null, policy: SupportPolicy = DEFAULT_SUPPORT_POLICY): number {
  if (bestDistance === null || !Number.isFinite(bestDistance)) return 0;
  const c = 1 - bestDistance / policy.maxUsefulDistance;
  return Math.max(0, Math.min(1, Number(c.toFixed(4))));
}

/** Distinct, order-preserving citations for hits within the useful-distance band. */
export function selectCitations(hits: readonly KbHit[], policy: SupportPolicy = DEFAULT_SUPPORT_POLICY): SupportCitation[] {
  const out: SupportCitation[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.distance > policy.maxUsefulDistance) continue;
    const key = `${h.source}#${h.heading ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: h.source, heading: h.heading });
  }
  return out;
}

// ── Prompt assembly ────────────────────────────────────────────────────────────────────
/** Join hits into a bounded, labelled context block the model can cite by [n]. */
export function buildContextBlock(hits: readonly KbHit[], policy: SupportPolicy = DEFAULT_SUPPORT_POLICY): string {
  const parts: string[] = [];
  let used = 0;
  let n = 0;
  for (const h of hits) {
    if (h.distance > policy.maxUsefulDistance) continue;
    n += 1;
    const label = `[${n}] ${h.source}${h.heading ? ` (${h.heading})` : ""}`;
    const body = h.content.trim();
    const block = `${label}\n${body}`;
    if (used + block.length > policy.maxContextChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

/** The grounded system prompt. Encodes the product rules the model must obey. */
export function buildSystemPrompt(brand: SupportBrandInfo, context: string): string {
  const email = brand.supportEmail ? brand.supportEmail : "the support team";
  const hasContext = context.trim().length > 0;
  return [
    `You are the support assistant for ${brand.name}, a real-money trade-prediction game.`,
    `Answer the visitor using ONLY the knowledge base context below. Do not invent facts,`,
    `figures, or policies. If the context does not contain the answer, say clearly that you`,
    `are not certain and offer to connect them with ${email}.`,
    ``,
    `Style rules, follow them exactly:`,
    `- Write in plain, natural, friendly language.`,
    `- Never use an em dash or en dash. Use a comma or a full stop instead.`,
    `- Be concise. Prefer short sentences and, where helpful, short numbered steps.`,
    `- When you use a fact from the context, keep it faithful to the source wording.`,
    `- Never ask for or repeat passwords, PINs, full card numbers, or one time codes.`,
    ``,
    hasContext ? `Knowledge base context:\n${context}` : `Knowledge base context: (no relevant entries were found)`,
  ].join("\n");
}

/** Build the full message list: system prompt + trimmed history + the new question. */
export function buildMessages(
  brand: SupportBrandInfo,
  hits: readonly KbHit[],
  history: readonly SupportHistoryTurn[],
  question: string,
  policy: SupportPolicy = DEFAULT_SUPPORT_POLICY,
): LlmMessage[] {
  const context = buildContextBlock(hits, policy);
  const messages: LlmMessage[] = [{ role: "system", content: buildSystemPrompt(brand, context) }];
  // Keep only prior user/assistant turns (drop any stored system turns), last 8, in order.
  const convo = history.filter((t) => t.role === "user" || t.role === "assistant").slice(-8);
  for (const t of convo) messages.push({ role: t.role as "user" | "assistant", content: t.content });
  messages.push({ role: "user", content: question });
  return messages;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────────────
export interface AnswerDeps {
  embed: EmbedFn;
  searchKb: SearchKbFn;
  llm: LlmFn;
  policy?: SupportPolicy;
}

export interface AnswerInput {
  siteId: string;
  question: string;
  history?: readonly SupportHistoryTurn[];
  brand: SupportBrandInfo;
}

export interface SupportAnswer {
  answer: string;
  citations: SupportCitation[];
  confidence: number;
  shouldEscalate: boolean;
  hits: KbHit[];
}

/**
 * Turn a question into a grounded answer. embed -> retrieve top-k -> build a grounded prompt
 * -> LLM -> strip em dashes -> attach citations + confidence + escalation flag. Pure with
 * respect to its injected ports, so it is fully unit-testable with fakes.
 */
export async function answerSupportQuestion(deps: AnswerDeps, input: AnswerInput): Promise<SupportAnswer> {
  const policy = deps.policy ?? DEFAULT_SUPPORT_POLICY;
  const q = String(input.question ?? "").trim();
  if (!q) throw new Error("EMPTY_QUESTION");

  const embedded = await deps.embed([q]);
  const vector = embedded[0];
  if (!vector || vector.length === 0) throw new Error("EMBED_FAILED");

  const hits = await deps.searchKb(input.siteId, vector, policy.topK);
  const usable = hits.filter((h) => Number.isFinite(h.distance));
  const best = usable.length ? usable[0]!.distance : null;
  const confidence = confidenceFromDistance(best, policy);
  const citations = selectCitations(usable, policy);

  const messages = buildMessages(input.brand, usable, input.history ?? [], q, policy);
  const raw = await deps.llm(messages, { temperature: 0, maxTokens: 500 });
  const answer = stripEmDashes(raw);

  const grounded = citations.length > 0 && confidence >= policy.escalateBelowConfidence;
  const shouldEscalate = !grounded;

  return { answer, citations, confidence, shouldEscalate, hits: usable };
}
