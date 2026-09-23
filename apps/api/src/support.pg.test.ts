import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { makePgSupportStore } from "./support.pg.js";
import { newConversationToken } from "./app.support.js";

/**
 * Issue 1 / F-48 — the PRODUCTION support store against the real migrated schema (0157): the
 * capability-token hash is written by the 4-arg fn_support_start and read back by getConversation,
 * while the operator list never selects it. Runs only when E2E_PG_DSN points at a fully migrated DB;
 * skipped in CI. Everything happens inside a rolled-back transaction.
 */
const DSN = process.env.E2E_PG_DSN;

test("F-48 (real schema): start binds the token hash; getConversation returns it; list does not", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const store = makePgSupportStore({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);
    const site = "00000000-0000-0000-0000-000000000001";
    const { token, hash } = newConversationToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const id = await store.start(site, { visitorId: "v-pg", accessHash: hash });
    const conv = await store.getConversation(id);
    assert.equal(conv?.accessHash, hash);
    assert.notEqual(conv?.accessHash, token, "only the hash is stored");
    const listed = (await store.listConversations(site, { limit: 5 })).find((x) => x.id === id);
    assert.equal(listed?.accessHash, null, "operator list never carries the hash");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
