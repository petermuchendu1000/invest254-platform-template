#!/usr/bin/env python3
"""Knowledge-base ingest for the support assistant.

Chunks the project docs, embeds each chunk with the local bge-small-en-v1.5 model (free, no quota,
384-dim, normalised), and upserts into public.kb_chunks. site_id NULL = shared knowledge for every
brand; pass a site UUID for a per-brand override set.

Local/free by design: embeddings run on-box via fastembed (ONNX). The SAME model is used at query
time by the API (Transformers.js, bge-small-en-v1.5), so vectors are compatible.

Usage:
  DATABASE_URL=postgres://... python3 packages/db/kb/ingest_kb.py            # ingest docs/ as shared
  python3 packages/db/kb/ingest_kb.py --docs docs --site <uuid>              # brand override set
Also importable: chunk_markdown(text, source) and ingest(conn, chunks, site_id).
"""
import os, re, sys, glob, argparse

MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_DOCS = os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs")

def chunk_markdown(text: str, source: str, target_chars: int = 1100, overlap: int = 150):
    """Split a markdown doc into heading-aware, size-bounded chunks."""
    lines = text.splitlines()
    sections, cur, heading = [], [], None
    for ln in lines:
        if re.match(r"^#{1,6}\s", ln):
            if cur:
                sections.append((heading, "\n".join(cur).strip())); cur = []
            heading = ln.lstrip("#").strip()
        else:
            cur.append(ln)
    if cur:
        sections.append((heading, "\n".join(cur).strip()))

    chunks, idx = [], 0
    for heading, body in sections:
        body = body.strip()
        if not body:
            continue
        if len(body) <= target_chars:
            chunks.append({"source": source, "heading": heading, "chunk_index": idx, "content": body}); idx += 1
        else:
            start = 0
            while start < len(body):
                piece = body[start:start + target_chars]
                chunks.append({"source": source, "heading": heading, "chunk_index": idx, "content": piece.strip()}); idx += 1
                start += target_chars - overlap
    return [c for c in chunks if c["content"]]

def collect_docs(docs_dir: str, extra_files=None):
    paths = sorted(glob.glob(os.path.join(docs_dir, "*.md")))
    for f in extra_files or []:
        if os.path.exists(f):
            paths.append(f)
    out = []
    for p in paths:
        out += chunk_markdown(open(p, encoding="utf-8").read(), os.path.relpath(p))
    return out

_embedder = None
def embed(texts):
    """Return a list of 384-float vectors for `texts` (bge-small, normalised)."""
    global _embedder
    from fastembed import TextEmbedding
    if _embedder is None:
        _embedder = TextEmbedding(MODEL)
    return [list(map(float, v)) for v in _embedder.embed(list(texts))]

def hash_embed(texts, dims: int = 384):
    """Deterministic zero-model embedder for tests: token-hashed bag-of-words, L2-normalised.

    Shares no code with the production model; it exists so e2e harnesses can validate the
    pgvector plumbing (storage, cosine ordering, RLS) without loading the ONNX model.
    """
    import hashlib, math, re as _re
    vecs = []
    for text in texts:
        v = [0.0] * dims
        for tok in _re.findall(r"[a-z0-9]+", text.lower()):
            h = int(hashlib.sha256(tok.encode()).hexdigest(), 16)
            v[h % dims] += 1.0 if (h >> 64) & 1 == 0 else -1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        vecs.append([x / norm for x in v])
    return vecs

def _vec_literal(v):
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

def ingest(conn, chunks, site_id=None, replace=True, embed_fn=None):
    """Embed + insert chunks into kb_chunks. replace=True clears the same (site, source) set first.

    embed_fn defaults to the production bge-small embedder; tests inject hash_embed so the
    heavy ONNX model never loads in constrained environments.
    """
    vecs = (embed_fn or embed)([c["content"] for c in chunks])
    with conn.cursor() as cur:
        if replace:
            srcs = sorted({c["source"] for c in chunks})
            if site_id is None:
                cur.execute("delete from public.kb_chunks where site_id is null and source = any(%s)", [srcs])
            else:
                cur.execute("delete from public.kb_chunks where site_id = %s and source = any(%s)", [site_id, srcs])
        for c, v in zip(chunks, vecs):
            cur.execute(
                """insert into public.kb_chunks(site_id, source, heading, chunk_index, content, embedding, token_count)
                   values (%s,%s,%s,%s,%s,%s::vector,%s)""",
                [site_id, c["source"], c.get("heading"), c["chunk_index"], c["content"],
                 _vec_literal(v), max(1, len(c["content"]) // 4)],
            )
    conn.commit()
    return len(chunks)

def main():
    import psycopg2
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default=DEFAULT_DOCS)
    ap.add_argument("--site", default=None)
    ap.add_argument("--extra", nargs="*", default=["README.md", "TEMPLATE.md", "HOSTING.md"])
    args = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr); sys.exit(2)
    chunks = collect_docs(args.docs, args.extra)
    conn = psycopg2.connect(dsn)
    print(f"ingested {ingest(conn, chunks, site_id=args.site)} chunks from {args.docs}")

if __name__ == "__main__":
    main()
