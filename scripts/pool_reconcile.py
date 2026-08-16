#!/usr/bin/env python3
"""
pool_reconcile.py — Phase 5 of the pool-brain (docs/25): nightly reconciliation of the daily
withdrawal pool. Read-only. Calls fn_pool_reconcile(day) (migration 0066) and asserts, per brand:

  1. HARD CAP   : amount - paid - reserved >= 0            (the 0062 CHECK; must always hold)
  2. LEDGER TIE : reserved = Σreserve−Σcommit−Σrelease  AND  paid = Σcommit   (from pool_ledger)
  3. PAYOUT TIE : pool-committed paid <= winning payouts the game actually credited that day

Any brand whose note != 'ok' is an anomaly. Exit code is 0 when everything ties, 1 when any
anomaly is found (so a cron/CI step fails loudly), 2 on a usage/connection error. Optionally
POSTs a compact JSON summary to SLACK_WEBHOOK_URL when anomalies are present.

Usage:
  DATABASE_URL=postgres://... python3 scripts/pool_reconcile.py [--day YYYY-MM-DD] [--days-back N] [--json]
"""
import os, sys, argparse, json, datetime as dt, urllib.request

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is required (pip install psycopg2-binary)", file=sys.stderr); sys.exit(2)

COLS = ["site_id", "slug", "trade_day", "amount_cents", "paid_cents", "reserved_cents",
        "available_cents", "ledger_reserved", "ledger_paid", "settled_payout_cents",
        "hardcap_ok", "reserved_tie_ok", "paid_tie_ok", "payout_tie_ok", "note"]


def kes(c):
    try:
        return f"KES {int(c) / 100:,.0f}"
    except Exception:
        return str(c)


def reconcile_day(cur, day):
    cur.execute("select " + ",".join(COLS) + " from fn_pool_reconcile(%s::date)", (day,))
    return [dict(zip(COLS, r)) for r in cur.fetchall()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", help="EAT day to check (YYYY-MM-DD). Default: today.")
    ap.add_argument("--days-back", type=int, default=0, help="Also check the N previous days (default 0).")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON only.")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr); return 2

    base = dt.date.fromisoformat(args.day) if args.day else dt.date.today()
    days = [base - dt.timedelta(days=i) for i in range(0, max(0, args.days_back) + 1)]

    conn = psycopg2.connect(url, connect_timeout=30); cur = conn.cursor()
    all_rows, anomalies = [], []
    try:
        for d in days:
            rows = reconcile_day(cur, d.isoformat())
            all_rows.extend(rows)
            anomalies.extend([r for r in rows if r["note"] != "ok"])
    finally:
        cur.close(); conn.close()

    if args.json:
        print(json.dumps({"days": [d.isoformat() for d in days], "rows": all_rows,
                          "anomalies": anomalies, "ok": not anomalies}, default=str, indent=2))
    else:
        print(f"Pool reconciliation — {', '.join(d.isoformat() for d in days)}")
        print("-" * 96)
        for r in all_rows:
            flag = "OK " if r["note"] == "ok" else "!! "
            print(f"{flag}{r['trade_day']} {r['slug']:<14} "
                  f"budget={kes(r['amount_cents'])}  paid={kes(r['paid_cents'])}  "
                  f"resv={kes(r['reserved_cents'])}  avail={kes(r['available_cents'])}  "
                  f"ledger(paid={kes(r['ledger_paid'])},resv={kes(r['ledger_reserved'])})  "
                  f"payouts={kes(r['settled_payout_cents'])}  -> {r['note']}")
        print("-" * 96)
        print(f"{'ANOMALIES: ' + str(len(anomalies)) if anomalies else 'All invariants hold.'}")

    hook = os.environ.get("SLACK_WEBHOOK_URL")
    if anomalies and hook:
        text = "*Pool reconciliation anomalies*\n" + "\n".join(
            f"• {a['trade_day']} {a['slug']}: {a['note']} "
            f"(paid={kes(a['paid_cents'])}, ledger_paid={kes(a['ledger_paid'])}, "
            f"resv={kes(a['reserved_cents'])}, payouts={kes(a['settled_payout_cents'])})"
            for a in anomalies)
        try:
            req = urllib.request.Request(hook, data=json.dumps({"text": text}).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=15)
        except Exception as e:
            print(f"WARN: Slack post failed: {e}", file=sys.stderr)

    return 1 if anomalies else 0


if __name__ == "__main__":
    sys.exit(main())
