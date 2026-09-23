import { test } from "node:test";
import assert from "node:assert/strict";
import { isForbiddenEnvFile, hasLiveDbUrl, scanText, scanRepo } from "./secret_scan.mts";

// Fixtures are assembled at runtime so this file never itself matches the scanner.
const J = (...p: string[]) => p.join("");

test("committed env files are forbidden, examples are allowed", () => {
  for (const f of [".env", ".e2e.env", "apps/web/.env", ".env.local", ".env.production", "x/prod.env"])
    assert.equal(isForbiddenEnvFile(f), true, f);
  for (const f of [".env.example", "apps/web/.env.example", "src/env.ts", "environment.md", ".envrc.md"])
    assert.equal(isForbiddenEnvFile(f), false, f);
});

test("postgres URL: live remote credential flagged; placeholders/local ignored", () => {
  assert.equal(hasLiveDbUrl(J("postgresql://postgres.abc:", "S3cretPw!9", "@aws-0-eu-west-1.pooler.supabase.com:5432/postgres")), true);
  assert.equal(hasLiveDbUrl("DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/postgres"), false);
  assert.equal(hasLiveDbUrl("postgres://postgres:postgres@localhost:5432/test"), false);
  assert.equal(hasLiveDbUrl("postgres://u:${PGPASSWORD}@db.example.com/x"), false);
  assert.equal(hasLiveDbUrl("no url here"), false);
  assert.equal(hasLiveDbUrl("postgresql://user.ref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"), false);
});

test("token rules fire on real-shaped secrets, never print values", () => {
  const lines = [
    J("github_pat_", "A".repeat(70)),
    J("sb_", "secret_", "abcdefghijklmnopqrstuv"),
    J("8836754209", ":AA", "B".repeat(33)),
    J("cf", "ut_", "C".repeat(40)),
    J("Fly", "V1 fm2_", "D".repeat(40)),
  ];
  const f = scanText("x.ts", lines.join("\n"));
  assert.deepEqual(f.map((x) => x.rule), ["github-token", "supabase-secret-key", "telegram-bot-token", "cloudflare-token", "fly-token"]);
  assert.ok(f.every((x) => !("value" in x)));
});

test("supabase role JWT flagged; generic short test JWT not flagged", () => {
  const payloadService = Buffer.from('{"role":"service_role"}').toString("base64url");
  const jwt = J("eyJhbGciOiJIUzI1NiJ9", ".", payloadService, ".", "s".repeat(43));
  assert.deepEqual(scanText("a.ts", jwt).map((x) => x.rule), ["supabase-jwt"]);
  const payloadUser = Buffer.from('{"sub":"u1","role":"player"}').toString("base64url");
  assert.equal(scanText("a.ts", J("eyJhbGciOiJIUzI1NiJ9", ".", payloadUser, ".", "s".repeat(43))).length, 0);
});

test("allow marker suppresses a reviewed line", () => {
  assert.equal(scanText("a.ts", J("sb_", "secret_", "abcdefghijklmnopqrstuv // secret-scan:allow")).length, 0);
});

test("scanRepo: env file is flagged even if unreadable; clean repo passes", () => {
  const files = [".e2e.env", "src/a.ts"];
  const res = scanRepo(files, (f) => { if (f === ".e2e.env") throw new Error("gone"); return "const x = 1;"; });
  assert.deepEqual(res, [{ file: ".e2e.env", line: 0, rule: "committed-env-file" }]);
  assert.deepEqual(scanRepo(["src/a.ts", ".env.example"], () => "ok"), []);
});
