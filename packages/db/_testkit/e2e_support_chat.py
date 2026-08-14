#!/usr/bin/env python3
"""End-to-end for the support-chat backend (migration 0057): RAG + recording + operator RLS.

Resets a local Postgres, applies the shim + ALL migrations, ingests the real docs into kb_chunks
with the deterministic zero-model hash_embedder (no ONNX load, no memory spike), then asserts:
  RAG        the retrieval pipeline is correct: canary chunks rank #1 by cosine distance,
             results are distance-ordered, and per-brand KB scoping holds (no cross-brand leak).
  RECORD     start/log/escalate RPCs persist the transcript stamped with the brand's site_id.
  RLS        a site operator reads ONLY its brand's conversations; platform_superadmin reads all;
             a player sees none (support data is operator-only).

Run: python3 packages/db/_testkit/e2e_support_chat.py   (needs local PG on /tmp:5433 + pgvector)
"""
import os, sys, glob, uuid
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "kb"))
import ingest_kb  # noqa: E402

DSN  = dict(host="/tmp", port=5433, user="postgres", dbname="invest254_test")
BASE = os.path.join(os.path.dirname(__file__), "..")
SHIM = os.path.join(os.path.dirname(__file__), "00_supabase_shim.sql")
DOCS = os.path.join(BASE, "..", "..", "docs")
SITE_A = "00000000-0000-0000-0000-000000000001"
ACTOR = str(uuid.uuid4()); PS = "platform_superadmin"

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def q1(cur, sql, args=None):
    cur.execute(sql, args or []); return cur.fetchone()

def reset_and_migrate():
    admin = psycopg2.connect(host="/tmp", port=5433, user="postgres", dbname="postgres"); admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname='invest254_test' and pid<>pg_backend_pid()")
        c.execute("drop database if exists invest254_test"); c.execute("create database invest254_test")
    admin.close()
    conn = psycopg2.connect(**DSN); conn.autocommit = True
    with conn.cursor() as c:
        c.execute(open(SHIM, encoding="utf-8").read())
        for f in sorted(glob.glob(os.path.join(BASE, "migrations", "00*.sql"))):
            c.execute(open(f, encoding="utf-8").read())
    return conn

def register(cur, phone, username, site):
    cur.execute("select fn_register_user(%s,%s,%s,null,%s)", [phone, username, "x" * 32, site])
    return q1(cur, "select id from profiles where site_id=%s and phone=%s", [site, phone])[0]

def search(cur, site, query, k=3):
    vec = ingest_kb.hash_embed([query])[0]
    cur.execute("select source, heading, distance from fn_kb_search(%s, %s::vector, %s)",
                [site, ingest_kb._vec_literal(vec), k])
    return cur.fetchall()

def count_as(conn, role, sub, site, table):
    with conn.cursor() as cur:
        cur.execute("begin"); cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", [sub])
        cur.execute("select set_config('request.jwt.claim.site', %s, true)", [site])
        cur.execute("select set_config('request.jwt.claim.role', %s, true)", [role])
        cur.execute(f"select count(*) from public.{table}")
        n = cur.fetchone()[0]; cur.execute("rollback")
    return n

def main():
    conn = reset_and_migrate(); conn.autocommit = True; cur = conn.cursor()
    for t in ("support_conversations", "support_messages"):
        cur.execute(f"grant select on public.{t} to authenticated")

    print("\n== INGEST: embed the docs into the shared KB ==")
    chunks = ingest_kb.collect_docs(DOCS, ["README.md", "TEMPLATE.md"])
    n = ingest_kb.ingest(conn, chunks, site_id=None, embed_fn=ingest_kb.hash_embed)
    total = q1(cur, "select count(*) from kb_chunks")[0]
    check(f"ingested {n} chunks into kb_chunks", total == n and n > 50, f"n={n} total={total}")

    print("\n== RAG: retrieval pipeline (embed -> store -> cosine order -> top-k -> KB scoping) ==")
    # The zero-model hash embedder is lexical, not semantic, so we do NOT assert semantic
    # relevance against the real docs here (that quality is delivered by the production
    # bge-small embedder). Instead we prove the embedder-AGNOSTIC plumbing is correct with
    # canary chunks whose unique tokens appear in no real doc: each must rank #1 by cosine
    # distance ahead of all 300+ real chunks, distances must be monotonically ordered, and
    # a brand's private canary must never surface for another brand.
    site_b = q1(cur, "select fn_platform_create_site(%s,%s,'brandb','Brand B')", [ACTOR, PS])[0]
    shared_canary = [{"source": "kb://canary/zephyrquux", "heading": "Zephyrquux",
                      "chunk_index": 0, "content": "The zephyrquux glimberton handles narwhalplex settlement."}]
    brandb_canary = [{"source": "kb://canary/blorptangle", "heading": "Blorptangle",
                      "chunk_index": 0, "content": "A blorptangle vortistream reconciles quibberflux entries."}]
    ingest_kb.ingest(conn, shared_canary, site_id=None, embed_fn=ingest_kb.hash_embed)
    ingest_kb.ingest(conn, brandb_canary, site_id=site_b, embed_fn=ingest_kb.hash_embed)

    rowsA = search(cur, SITE_A, "zephyrquux glimberton narwhalplex", k=5)
    check("shared canary ranks #1 ahead of all real chunks",
          "zephyrquux" in rowsA[0][0], f"top={rowsA[0][0]}")
    dists = [r[2] for r in rowsA]
    check("results are ordered by ascending cosine distance", dists == sorted(dists), f"{dists}")

    # Brand-B's private canary is retrievable for brand B ...
    rowsB = search(cur, site_b, "blorptangle vortistream quibberflux", k=5)
    check("brand-B private canary ranks #1 for brand B", "blorptangle" in rowsB[0][0], f"top={rowsB[0][0]}")
    # ... but NEVER leaks into brand A's search (fn_kb_search scopes to shared + own site).
    leak = [r[0] for r in search(cur, SITE_A, "blorptangle vortistream quibberflux", k=5)]
    check("brand-B private canary never surfaces for brand A", not any("blorptangle" in s for s in leak), f"got {leak}")

    print("\n== RECORD: start / log / escalate persist per brand ==")
    convA = q1(cur, "select fn_support_start(%s,%s,null)", [SITE_A, "visitorA"])[0]
    q1(cur, "select fn_support_log(%s,'user',%s,'[]'::jsonb,null)", [convA, "How do I withdraw?"])
    q1(cur, "select fn_support_log(%s,'assistant',%s,%s,%s)", [convA, "You can withdraw via M-Pesa B2C from your wallet.", '[{"source":"docs/08-payments-mpesa.md"}]', 0.82])
    convB = q1(cur, "select fn_support_start(%s,%s,null)", [site_b, "visitorB"])[0]
    q1(cur, "select fn_support_log(%s,'user',%s,'[]'::jsonb,null)", [convB, "Is there a welcome bonus?"])
    q1(cur, "select fn_support_escalate(%s,%s,null)", [convA, "player@example.com"])

    msgs = q1(cur, "select count(*) from support_messages where site_id=%s", [SITE_A])[0]
    esc = q1(cur, "select escalated, contact_email, status from support_conversations where id=%s", [convA])
    check("brand-A messages recorded with site_id", msgs == 2, f"msgs={msgs}")
    check("escalation captured contact + status", esc[0] is True and esc[1] == "player@example.com" and esc[2] == "escalated", f"{esc}")
    check("assistant message stored confidence",
          q1(cur, "select confidence from support_messages where conversation_id=%s and role='assistant'", [convA])[0] is not None)

    print("\n== RLS: operators read only their brand; platform reads all; players none ==")
    adminA = register(cur, "254700000010", "admA", SITE_A)
    platform = register(cur, "254700000011", "plat", SITE_A)
    player = register(cur, "254700000012", "playr", SITE_A)
    cur.execute("update profiles set role='admin' where id=%s", [adminA])
    cur.execute("update profiles set role='platform_superadmin' where id=%s", [platform])
    A_conv = q1(cur, "select count(*) from support_conversations where site_id=%s", [SITE_A])[0]
    ALL_conv = q1(cur, "select count(*) from support_conversations")[0]
    check(f"admin/site=A sees only brand-A conversations ({A_conv})",
          count_as(conn, "admin", adminA, SITE_A, "support_conversations") == A_conv and A_conv < ALL_conv)
    check(f"platform sees ALL conversations ({ALL_conv})",
          count_as(conn, PS, platform, SITE_A, "support_conversations") == ALL_conv and ALL_conv > A_conv)
    check("player sees ZERO conversations (operator-only data)",
          count_as(conn, "player", player, SITE_A, "support_conversations") == 0)
    check("admin/site=A sees only brand-A messages",
          count_as(conn, "admin", adminA, SITE_A, "support_messages") == q1(cur, "select count(*) from support_messages where site_id=%s", [SITE_A])[0])

    print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("ALL SUPPORT-CHAT DB E2E SCENARIOS PASSED")

if __name__ == "__main__":
    main()
