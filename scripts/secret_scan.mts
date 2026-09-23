/**
 * secret_scan.mts — CI gate: fail the build if a live credential is committed to the repo.
 *
 * Why (BUGLOG #41): `.e2e.env` — carrying the PRODUCTION DATABASE_URL (with password) and the API's
 * token-signing secret — was committed on 2026-08-04 and was publicly downloadable from this PUBLIC
 * repo for ~7 weeks. A direct Postgres connection bypasses every RLS / API / platform-scope guard,
 * so one committed secret defeats the entire multi-tenant isolation model. This gate makes that
 * class of mistake impossible to merge again.
 *
 * Scope: every file tracked at HEAD (`git ls-files`). High-confidence patterns only, so the gate
 * stays quiet on test fixtures and placeholders. A line may opt out with the marker
 * `secret-scan:allow` (reviewers must justify it).
 *
 * Output never prints a secret value — only file:line and the rule name.
 * Run:  node --import tsx scripts/secret_scan.mts        (exit 1 on any finding)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Rule {
  name: string;
  re: RegExp;
}

/** Placeholder passwords/hosts that are safe to commit (docs, examples, local dev). */
const PLACEHOLDER_PASSWORD = /^(password|pass|postgres|user|secret|changeme|xxx+|\*+|\$\{?[A-Z_]+\}?|<[^>]+>)$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|host|db|postgres|pg|HOST)$/i;

export const RULES: Rule[] = [
  { name: "github-token", re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "supabase-secret-key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { name: "telegram-bot-token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { name: "cloudflare-token", re: /\bcfut_[A-Za-z0-9]{30,}/ },
  { name: "fly-token", re: /FlyV1 fm[12]_[A-Za-z0-9+/=_-]{20,}/ },
  { name: "stripe-live-key", re: /\b(sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  // A signed JWT whose payload claims a Supabase role (anon/service_role) — real project keys.
  { name: "supabase-jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*?(?:c2VydmljZV9yb2xl|InJvbGUiOiJhbm9u|cm9sZSI6ImFub24)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{20,}/ },
];

/** Tracked dotenv files are forbidden outright (only `*.example` templates may be committed). */
export function isForbiddenEnvFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (!/^\.env(\..+)?$|^\.[\w-]+\.env$|\.env$/.test(base)) return false;
  return !/\.example$/.test(base);
}

/** Postgres URL with a non-placeholder password pointing at a non-local host. */
export function hasLiveDbUrl(line: string): boolean {
  const re = /postgres(?:ql)?:\/\/([^:\s'"/@]+):([^@\s'"]+)@([^:/\s'"]+)/g;
  for (const m of line.matchAll(re)) {
    const [, , password, host] = m;
    // Short passwords (< 6 chars, e.g. "pw" in URL-rewrite fixtures) are placeholders; real DB
    // passwords are longer. Placeholder words and local hosts are never live credentials.
    if (password.length < 6 || PLACEHOLDER_PASSWORD.test(password) || LOCAL_HOST.test(host)) continue;
    return true;
  }
  return false;
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("secret-scan:allow")) return;
    for (const r of RULES) if (r.re.test(line)) out.push({ file, line: i + 1, rule: r.name });
    if (hasLiveDbUrl(line)) out.push({ file, line: i + 1, rule: "postgres-url-with-password" });
  });
  return out;
}

const SKIP = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip)$/i;

export function scanRepo(files: string[], read: (f: string) => string): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (isForbiddenEnvFile(f)) findings.push({ file: f, line: 0, rule: "committed-env-file" });
    if (SKIP.test(f)) continue;
    let text: string;
    try {
      text = read(f);
    } catch {
      continue; // deleted in the working tree / unreadable — not a committed secret
    }
    findings.push(...scanText(f, text));
  }
  return findings;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = scanRepo(files, (f) => readFileSync(f, "utf8"));
  if (findings.length === 0) {
    console.log(`secret-scan: OK (${files.length} tracked files, 0 findings)`);
  } else {
    for (const x of findings) console.error(`secret-scan: ${x.rule}  ${x.file}${x.line ? `:${x.line}` : ""}`);
    console.error(`secret-scan: FAILED — ${findings.length} finding(s). Remove the secret, rotate it, and never commit env files.`);
    process.exit(1);
  }
}
