# 23 — Support Chat (autonomous RAG assistant)

> Status: **implemented**. DB backend `packages/db/migrations/0057_support_chat.sql`; grounded-answer
> core `packages/shared/src/support.ts`; API `apps/api/src/app.support.ts` (+ `support.pg.ts`
> adapters); web widget `apps/web/src/components/support/SupportWidget.tsx`; operator inbox
> `apps/web/src/app/admin/support/page.tsx`. Covered by unit + end-to-end tests.

A Tawk-style, self-serve support assistant. A visitor asks in natural language; the server grounds
an answer in the brand's knowledge base (RAG over pgvector), records every turn for operators, and
offers a human handoff when it is unsure. Free-tier by design.

## 1. Flow

1. Visitor opens the floating widget and asks a question.
2. API embeds the question, retrieves the top-k knowledge-base chunks for the brand
   (`fn_kb_search`: shared KB plus that brand's overrides), and builds a grounded prompt.
3. A free LLM answers using only that context. The answer is stripped of em dashes, carries its
   citations, and gets a confidence score from the best match distance.
4. Both the visitor turn and the assistant turn are recorded (`fn_support_log`) stamped with the
   brand `site_id`. Low confidence or no coverage flags a human handoff (`fn_support_escalate`).
5. Operators read conversations in the admin inbox (`/admin/support`), brand-scoped by RLS.

## 2. Data model (migration 0057)

- `kb_chunks(site_id, source, heading, chunk_index, content, embedding vector(384), token_count)`
  — `site_id NULL` = shared KB; a brand UUID = that brand's override set.
- `support_conversations(site_id, user_id, visitor_id, status, escalated, contact_email/phone, ...)`
- `support_messages(conversation_id, site_id, role, content, sources jsonb, confidence real, ...)`
- RPCs (service_role only): `fn_kb_search`, `fn_support_start`, `fn_support_log`, `fn_support_escalate`.
- RLS: operators (admins) read only their brand; `platform_superadmin` reads all; players see none.

## 3. REST API (`/api/v1/support`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/support/conversations` | optional | Start a conversation. Anonymous by default; a bearer attributes it to the player and their brand. Body: `{ visitorId?, siteId? }`. |
| POST | `/support/conversations/:id/messages` | optional | `{ message }` → `{ answer, citations, confidence, shouldEscalate }`. Records both turns. Rate limited per IP. |
| POST | `/support/conversations/:id/escalate` | optional | `{ email?, phone? }` → flags the conversation for follow up. |
| GET | `/support/conversations` | admin+ | Brand-scoped list (superadmin sees all). |
| GET | `/support/conversations/:id` | admin+ | Full transcript with sources + confidence. |

## 4. Enablement (all free-tier)

Support chat stays **off** until both the embedder and the LLM are configured (otherwise the
`/support/*` routes are not registered). Set on the API service:

```
# Query embedder — Cloudflare Workers AI, same model + 384 dims as ingest (free tier)
CF_ACCOUNT_ID=<cloudflare account id>
CF_AI_API_TOKEN=<workers ai token>
# CF_EMBED_MODEL defaults to @cf/baai/bge-small-en-v1.5

# LLM — any OpenAI-compatible endpoint; Groq free tier by default
SUPPORT_LLM_API_KEY=<groq api key>   # or set GROQ_API_KEY (used as a fallback)
# SUPPORT_LLM_BASE_URL defaults to https://api.groq.com/openai/v1
# SUPPORT_LLM_MODEL   defaults to llama-3.1-8b-instant

# Optional guards
SUPPORT_CHAT_ENABLED=false      # force-off even when creds are present
SUPPORT_MSG_LIMIT=30            # messages per IP per window
SUPPORT_MSG_WINDOW_MS=10000
```

The web widget calls the API at `NEXT_PUBLIC_API_BASE_URL`; no extra web config is required.

> Note: Groq's free tier caps tokens-per-minute (e.g. 6000 TPM for `llama-3.1-8b-instant`). The
> grounded prompt is bounded by `maxContextChars`; the per-IP rate limit keeps normal traffic under
> the cap. For heavier volume, lower `topK`/context, use a smaller-context model, or a paid tier.
> The adapters send an explicit `User-Agent` (Groq is fronted by Cloudflare, which blocks default
> library agents).

### Live validation

`scripts/support_smoke.ts` wires the real production adapters (Postgres store + `fn_kb_search` +
Cloudflare embedder + Groq LLM) to `answerSupportQuestion` and runs a few questions against the
live knowledge base, records a transcript, escalates, and cleans up its test rows:

```
DATABASE_URL=... CF_ACCOUNT_ID=... CF_AI_API_TOKEN=... SUPPORT_LLM_API_KEY=... \
  node --import tsx scripts/support_smoke.ts
```

## 5. Ingesting the knowledge base

The KB is embedded with `bge-small-en-v1.5` (free, local, 384-dim) and upserted into `kb_chunks`.

```
DATABASE_URL=postgres://... python3 packages/db/kb/ingest_kb.py            # ingest docs/ as shared KB
python3 packages/db/kb/ingest_kb.py --docs docs --site <uuid>              # per-brand override set
```

`ingest_kb.ingest(...)` accepts a pluggable `embed_fn`; the production default is bge-small, while
the test harness injects a deterministic zero-model embedder so no ML model loads in CI.

## 6. Design rules

- Answer **only** from the knowledge base. When the context does not cover a question, say so and
  offer a human. Never invent facts, figures, or policies.
- 100% natural language, **zero em dashes** in anything shown to a visitor (`stripEmDashes`).
- Never request or echo passwords, PINs, full card numbers, or one time codes.
- Every inquiry is recorded for operator analysis, stamped with the brand `site_id`.

## 7. Tests

- `packages/shared/src/support.test.ts` — grounded-answer core (prompt, confidence, citations,
  em-dash stripping, escalation).
- `apps/api/src/app.support.e2e.test.ts` — full HTTP flow: RAG grounding, per-brand KB isolation,
  cross-brand refusal, anonymous vs authed attribution, escalation, operator RLS, validation,
  history replay, LLM-failure resilience, rate limiting.
- `apps/web/src/lib/support/format.test.ts` — visitor-facing error mapping + citation labels.
- `packages/db/_testkit/e2e_support_chat.py` — the SQL layer (retrieval pipeline, recording, RLS).
