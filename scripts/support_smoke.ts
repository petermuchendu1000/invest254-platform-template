/**
 * Live smoke test for the support-chat pipeline. Wires the REAL production adapters
 * (support.pg.ts: Postgres store + fn_kb_search + Cloudflare bge-small embedder + Groq LLM)
 * to the shared answerSupportQuestion core, runs a few natural-language questions against the
 * live knowledge base, records a transcript, escalates, and then cleans up its test rows.
 *
 * Run: node --import tsx scripts/support_smoke.ts   (needs DATABASE_URL, CF_*, SUPPORT_LLM_API_KEY)
 */
import { Pool } from 'pg';
import { answerSupportQuestion, type SupportPolicy } from '@invest254/shared';
import type { Querier } from '@invest254/engine';
import {
  makePgSupportStore, makePgSearchKb, makeCloudflareEmbedder, makeOpenAiCompatibleLlm, makeBrandInfo,
} from '../apps/api/src/support.pg.js';

const SITE = '00000000-0000-0000-0000-000000000001';
// Leaner context keeps each grounded prompt well under Groq's free-tier 6000 tokens/min.
const POLICY: SupportPolicy = { topK: 4, maxUsefulDistance: 0.62, escalateBelowConfidence: 0.35, maxContextChars: 2200 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUESTIONS = [
  'How do I deposit money using M-Pesa?',
  'What percentage is the affiliate revenue share?',
  'What is the airspeed velocity of an unladen swallow?', // out of scope -> should escalate
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = pool as unknown as Querier;
  const store = makePgSupportStore(q);
  const deps = { embed: makeCloudflareEmbedder(), searchKb: makePgSearchKb(q), llm: makeOpenAiCompatibleLlm(), policy: POLICY };
  const brand = await makeBrandInfo(q)(SITE);
  console.log(`brand: ${brand.name} (support: ${brand.supportEmail ?? 'n/a'})\n`);

  const conv = await store.start(SITE, { visitorId: 'smoke-test' });
  console.log(`opened conversation ${conv}\n`);

  let emDashFound = false;
  for (const question of QUESTIONS) {
    const res = await answerSupportQuestion(deps, { siteId: SITE, question, brand });
    await store.log(conv, 'user', question, [], null);
    await store.log(conv, 'assistant', res.answer, res.citations, res.confidence);
    if (/[\u2014\u2013]/.test(res.answer)) emDashFound = true;
    console.log(`Q: ${question}`);
    console.log(`   confidence=${res.confidence.toFixed(3)} escalate=${res.shouldEscalate} citations=${res.citations.map((c) => c.heading ?? c.source.split('/').pop()).slice(0, 3).join(' | ') || 'none'}`);
    console.log(`   A: ${res.answer.replace(/\n/g, ' ').slice(0, 240)}\n`);
    await sleep(20_000); // stay under the free-tier tokens-per-minute budget
  }

  await store.escalate(conv, { email: 'smoke@example.com' });
  const recorded = await store.listMessages(conv);
  const c = await store.getConversation(conv);
  console.log(`recorded ${recorded.length} messages; escalated=${c?.escalated} status=${c?.status} contact=${c?.contactEmail}`);
  console.log(`em dash in any answer: ${emDashFound}`);

  // Clean up the smoke-test rows so the live DB stays tidy.
  await q.query('delete from support_conversations where id = $1', [conv]);
  const left = await q.query('select count(*) from support_conversations where visitor_id = $1', ['smoke-test']);
  console.log(`cleanup done; smoke conversations remaining: ${left.rows[0].count}`);

  await pool.end();
  console.log(`\nSMOKE TEST ${emDashFound ? 'FAILED (em dash present)' : 'PASSED'}`);
  if (emDashFound) process.exit(1);
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1); });
