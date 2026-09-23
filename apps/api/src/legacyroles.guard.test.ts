import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * docs/42 UI-11 / BUGLOG #40 — the legacy `superadmin` tier was removed. A role literal 'superadmin'
 * in executable code is at best dead and at worst a latent grant if such a token ever existed. This
 * guard fails CI if one reappears in any app/package source (tests and comments excluded). The DB's
 * inert allow-lists are covered by docs/41 and are not scanned here.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const DIRS = ["apps/api/src", "apps/engine/src", "apps/web/src", "packages/shared/src"];
const LITERAL = /(['"`])superadmin\1/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "dist") yield* files(p); continue; }
    if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx|mts)$/.test(name)) yield p;
  }
}

test("UI-11: no legacy 'superadmin' role literal in executable source", () => {
  const hits: string[] = [];
  for (const d of DIRS) {
    for (const f of files(join(ROOT, d))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").trim();
        if (code.startsWith("*") || code.startsWith("/*")) return;
        if (LITERAL.test(code)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
