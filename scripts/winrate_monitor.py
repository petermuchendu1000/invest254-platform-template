#!/usr/bin/env python3
"""
Realized-vs-configured win-rate & RTP monitor (per brand).

Reads DATABASE_URL from the environment and reports, for every ACTIVE brand:
  - the CONFIGURED economy (target_win_rate, house_edge -> target RTP, cap) from site_game_config
  - the REALIZED win rate + RTP over rolling windows (1h / 24h / current UTC day)
  - a breakdown EXCLUDING marketers and admin-overridden users (the population the pool controller
    will actually govern), so a few rigged accounts can't mask a systemic drift
  - an ALERT when, on a window with enough samples, realized diverges from configured beyond tolerance

Exit code is non-zero when any brand is in ALERT, so a scheduler/CI can act on it.

Usage:  DATABASE_URL=postgres://... python3 scripts/winrate_monitor.py [--min-samples 50] [--tol 0.10]
"""
import os, sys, argparse, json

MIN_SAMPLES_DEFAULT = 50
WR_TOL_DEFAULT = 0.10       # abs win-rate tolerance
RTP_OVERPAY_TOL = 0.15      # realized RTP may exceed target RTP by at most this before alert

WINDOWS = [
    ("1h",   "settled_at >= now() - interval '1 hour'"),
    ("24h",  "settled_at >= now() - interval '24 hours'"),
    ("today_utc", "settled_at >= date_trunc('day', now() at time zone 'utc')"),
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-samples", type=int, default=MIN_SAMPLES_DEFAULT)
    ap.add_argument("--tol", type=float, default=WR_TOL_DEFAULT)
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr); return 2
    import psycopg2
    conn = psycopg2.connect(url, connect_timeout=30); cur = conn.cursor()

    cur.execute("""select s.id, s.slug, c.target_win_rate, c.house_edge, c.max_multiplier, c.version
                     from site_game_config c join sites s on s.id=c.site_id
                    where s.status='active' order by s.slug""")
    sites = cur.fetchall()

    report, any_alert = [], False
    for site_id, slug, twr, he, mm, ver in sites:
        twr, he = float(twr), float(he)
        target_rtp = 1 - he
        site_rows = {"site": slug, "configured": {"target_win_rate": twr, "target_rtp": round(target_rtp, 4),
                     "max_multiplier": float(mm), "config_version": int(ver)}, "windows": {}, "alerts": []}
        for wname, wsql in WINDOWS:
            # Governed population = real players who are NOT marketers and NOT admin-overridden.
            cur.execute(f"""
              select count(*) n,
                     avg((p.result='win')::int)::float wr,
                     coalesce(sum(p.stake),0) staked,
                     coalesce(sum(p.payout),0) paid
                from positions p
                join profiles pr on pr.id = p.user_id
                left join user_overrides o on o.user_id = p.user_id
               where p.site_id = %s and p.status='settled' and {wsql}
                 and pr.role <> 'marketer' and o.user_id is null
            """, (site_id,))
            n, wr, staked, paid = cur.fetchone()
            n = int(n); staked = int(staked); paid = int(paid)
            rtp = (paid / staked) if staked else None
            w = {"n": n, "realized_wr": round(wr, 4) if wr is not None else None,
                 "realized_rtp": round(rtp, 4) if rtp is not None else None,
                 "staked_kes": round(staked/100, 2), "paid_kes": round(paid/100, 2),
                 "house_ggr_kes": round((staked - paid)/100, 2)}
            site_rows["windows"][wname] = w
            # Alert on the 24h window (enough signal, not too laggy).
            if wname == "24h" and n >= args.min_samples and wr is not None:
                if abs(wr - twr) > args.tol:
                    site_rows["alerts"].append(f"WIN_RATE_DRIFT realized={wr:.3f} vs target={twr:.3f}")
                if rtp is not None and rtp > target_rtp + RTP_OVERPAY_TOL:
                    site_rows["alerts"].append(f"RTP_OVERPAY realized={rtp:.3f} vs target={target_rtp:.3f} (house bleeding)")
        if site_rows["alerts"]:
            any_alert = True
        report.append(site_rows)

    conn.close()

    if args.json:
        print(json.dumps({"alert": any_alert, "sites": report}, indent=2)); return 1 if any_alert else 0

    print("="*72); print("WIN-RATE / RTP MONITOR (governed players: excl. marketers + overrides)"); print("="*72)
    for s in report:
        c = s["configured"]
        print(f"\n[{s['site']}]  target win {c['target_win_rate']:.3f} | target RTP {c['target_rtp']:.3f} | cap x{c['max_multiplier']} | cfg v{c['config_version']}")
        for wname, w in s["windows"].items():
            wr = f"{w['realized_wr']:.3f}" if w['realized_wr'] is not None else "  -  "
            rtp = f"{w['realized_rtp']:.3f}" if w['realized_rtp'] is not None else "  -  "
            print(f"   {wname:10} n={w['n']:>5}  win={wr}  rtp={rtp}  house_ggr=KES {w['house_ggr_kes']:>12,.0f}")
        for a in s["alerts"]:
            print(f"   \u26a0\ufe0f  ALERT: {a}")
    print("\nOVERALL:", "\u26a0\ufe0f ALERT" if any_alert else "\u2705 within tolerance")
    return 1 if any_alert else 0

if __name__ == "__main__":
    sys.exit(main())
