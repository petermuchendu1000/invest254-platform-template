/**
 * One-shot brand (client) onboarding for the platform (docs/20, docs/21). A superadmin supplies a
 * single JSON config (slug, name, domain, currency, colours, game economy, ...) and this creates a
 * LIVE tenant instantly: it upserts the `sites` row and `site_game_config`, points the brand at its
 * domain, then self-verifies that the brand resolves by host AND that the support-chat pipeline
 * answers for the new brand (shared knowledge base works immediately; per-brand overrides optional).
 *
 * Idempotent by slug: re-running updates the brand in place. Runs as service_role (DATABASE_URL),
 * matching the "data entry + DNS" onboarding model. DNS/custom-domain attach at the CDN is the only
 * step outside the database; this script prints the exact action to take (or automate) there.
 *
 * Run: node --import tsx scripts/onboard_client.ts scripts/onboard.example.json
 * Needs: DATABASE_URL (+ CF_ACCOUNT_ID, CF_AI_API_TOKEN, SUPPORT_LLM_API_KEY|GROQ_API_KEY for the
 * optional support-pipeline verification).
 */
import fs from 'node:fs';
import { Pool } from 'pg';
import type { Querier } from '@invest254/engine';
import { answerSupportQuestion } from '@invest254/shared';
import { makeCloudflareEmbedder, makePgSearchKb, makeOpenAiCompatibleLlm, makeBrandInfo } from '../apps/api/src/support.pg.js';

interface OnboardConfig {
  slug: string;
  name: string;
  primaryDomain: string;
  currency?: string;
  locale?: string;
  theme?: 'dark' | 'light' | 'auto';
  colors?: { primary?: string; bg?: string; accent?: string };
  wordmarkText?: string;
  licenceLine?: string;
  supportEmail?: string;
  /** Optional CDN automation: when set (with a Pages-scoped CF_PAGES_API_TOKEN) the script attaches
   *  the domain to the Cloudflare Pages web project and (if zoneId given) creates the CNAME. */
  cloudflare?: { pagesProject?: string; zoneId?: string; cnameTarget?: string };
  game?: Partial<{
    houseEdge: number; maxMultiplier: number; minStake: number; maxStake: number; minWithdrawal: number;
    defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number; targetWinRate: number;
  }>;
  verify?: { question?: string };
}

function loadConfig(): OnboardConfig {
  const path = process.argv[2];
  if (!path) throw new Error('usage: onboard_client.ts <config.json>');
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8')) as OnboardConfig;
  if (!cfg.slug || !cfg.name || !cfg.primaryDomain) throw new Error('config needs slug, name, primaryDomain');
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(cfg.slug)) throw new Error('slug must be lowercase-hyphen (a-z0-9-)');
  return cfg;
}

async function main() {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = pool as unknown as Querier;

  // 1) Upsert the brand row (idempotent by slug).
  const existing = await q.query('select id from sites where slug = $1', [cfg.slug]);
  const fields = {
    name: cfg.name,
    primary_domain: cfg.primaryDomain.trim().toLowerCase(),
    currency: cfg.currency ?? 'KES',
    locale: cfg.locale ?? 'en-KE',
    theme: cfg.theme ?? 'dark',
    color_primary: cfg.colors?.primary ?? '#22c55e',
    color_bg: cfg.colors?.bg ?? '#0a0a0a',
    color_accent: cfg.colors?.accent ?? '#06b6d4',
    wordmark_text: cfg.wordmarkText ?? cfg.primaryDomain,
    licence_line: cfg.licenceLine ?? null,
    support_email: cfg.supportEmail ?? null,
    status: 'active',
  };
  let siteId: string;
  if (existing.rows.length) {
    siteId = String(existing.rows[0].id);
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await q.query(`update sites set ${sets}, updated_at = now() where id = $1`, [siteId, ...Object.values(fields)]);
    console.log(`updated brand ${cfg.slug} (${siteId})`);
  } else {
    const cols = ['slug', ...Object.keys(fields)];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await q.query(`insert into sites (${cols.join(', ')}) values (${ph}) returning id`, [cfg.slug, ...Object.values(fields)]);
    siteId = String(r.rows[0].id);
    console.log(`created brand ${cfg.slug} (${siteId})`);
  }

  // 2) Upsert the brand's game economy.
  const g = cfg.game ?? {};
  await q.query(
    `insert into site_game_config
       (site_id, house_edge, max_multiplier, min_stake, max_stake, min_withdrawal,
        default_duration_s, tick_rate_ms, drift_bias, volatility, target_win_rate)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (site_id) do update set
       house_edge=excluded.house_edge, max_multiplier=excluded.max_multiplier, min_stake=excluded.min_stake,
       max_stake=excluded.max_stake, min_withdrawal=excluded.min_withdrawal, default_duration_s=excluded.default_duration_s,
       tick_rate_ms=excluded.tick_rate_ms, drift_bias=excluded.drift_bias, volatility=excluded.volatility,
       target_win_rate=excluded.target_win_rate, version = site_game_config.version + 1, updated_at = now()`,
    [siteId, g.houseEdge ?? 0.75, g.maxMultiplier ?? 5.0, g.minStake ?? 25000, g.maxStake ?? 5000000,
     g.minWithdrawal ?? 25000, g.defaultDurationS ?? 10, g.tickRateMs ?? 150, g.driftBias ?? 0.30,
     g.volatility ?? 1.0, g.targetWinRate ?? 0.125],
  );
  console.log('game economy set');

  // 3) Verify brand resolution by host (mirrors the API's brandByHost resolver in server.ts).
  const host = cfg.primaryDomain.trim().toLowerCase();
  const bres = await q.query(
    `select id, slug, name, primary_domain, currency from sites
      where status='active' and (lower(primary_domain)=$1 or lower(slug)=$1) limit 1`,
    [host],
  );
  const resolves = bres.rows.length > 0 && String(bres.rows[0].id) === siteId;
  console.log(`brand resolves by host '${host}': ${resolves ? 'YES' : 'NO'}`);

  // 4) Verify the support pipeline for the new brand (shared KB works immediately).
  const haveAi = Boolean(process.env.CF_ACCOUNT_ID && (process.env.SUPPORT_LLM_API_KEY || process.env.GROQ_API_KEY));
  const question = cfg.verify?.question;
  if (haveAi && question) {
    const brand = await makeBrandInfo(q)(siteId);
    const res = await answerSupportQuestion(
      { embed: makeCloudflareEmbedder(), searchKb: makePgSearchKb(q), llm: makeOpenAiCompatibleLlm(),
        policy: { topK: 4, maxUsefulDistance: 0.62, escalateBelowConfidence: 0.35, maxContextChars: 2200 } },
      { siteId, question, brand },
    );
    console.log(`\nsupport check for ${brand.name}:`);
    console.log(`  Q: ${question}`);
    console.log(`  confidence=${res.confidence.toFixed(3)} escalate=${res.shouldEscalate} citations=${res.citations.map((c) => c.heading ?? c.source.split('/').pop()).slice(0, 2).join(' | ') || 'none'}`);
    console.log(`  A: ${res.answer.replace(/\n/g, ' ').slice(0, 200)}`);
  } else {
    console.log('\nsupport check skipped (set CF_ACCOUNT_ID + GROQ_API_KEY and verify.question to run it)');
  }

  // 5) The one non-DB step: point the domain at the platform (CDN custom domain + SSL).
  await attachDomain(cfg, host);
  console.log(`\nBrand ${cfg.name} is live: site_id=${siteId}, domain=${host}, status=active.`);

  await pool.end();
}

/**
 * Attach the brand domain at the CDN. Automated when cfg.cloudflare.pagesProject + a Pages-scoped
 * CF_PAGES_API_TOKEN are provided (the Workers-AI token cannot do this); otherwise prints the step.
 */
async function attachDomain(cfg: OnboardConfig, host: string): Promise<void> {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_PAGES_API_TOKEN;
  const project = cfg.cloudflare?.pagesProject;
  console.log(`\nDNS / hosting:`);
  if (!account || !token || !project) {
    console.log(`  Add '${host}' as a custom domain on the web project (Cloudflare Pages) and set the`);
    console.log(`  brand's M-Pesa callbacks to .../s/${cfg.slug}/deposits/mpesa/callback . SSL is auto-issued.`);
    console.log(`  (Automate this by setting cloudflare.pagesProject in the config + a Pages-scoped CF_PAGES_API_TOKEN.)`);
    return;
  }
  const post = async (path: string, body: unknown): Promise<{ ok: boolean; detail: string }> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'invest254-onboard/1.0' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { success?: boolean; errors?: unknown };
    return { ok: Boolean(j.success), detail: j.success ? 'ok' : JSON.stringify(j.errors).slice(0, 200) };
  };
  const dom = await post(`/accounts/${account}/pages/projects/${project}/domains`, { name: host });
  console.log(`  Pages custom domain '${host}' -> ${project}: ${dom.ok ? 'attached (SSL provisioning)' : 'FAILED ' + dom.detail}`);
  if (cfg.cloudflare?.zoneId && cfg.cloudflare?.cnameTarget) {
    const dns = await post(`/zones/${cfg.cloudflare.zoneId}/dns_records`, { type: 'CNAME', name: host, content: cfg.cloudflare.cnameTarget, proxied: true });
    console.log(`  DNS CNAME ${host} -> ${cfg.cloudflare.cnameTarget}: ${dns.ok ? 'created' : 'FAILED ' + dns.detail}`);
  }
  console.log(`  Then set the brand's M-Pesa callbacks to .../s/${cfg.slug}/deposits/mpesa/callback .`);
}

main().catch((e) => { console.error('ONBOARD ERROR:', e); process.exit(1); });
