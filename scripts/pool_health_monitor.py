#!/usr/bin/env python3
"""
Pool-health monitor (docs/25 §15.7, BUGLOG #12) — an ACTIVE safety net that catches pool starvation
of ANY cause, including the low-volume blind spot that let incident #12 go unnoticed.

Why this exists alongside winrate_monitor.py: that monitor only alerts on windows with >=50 samples,
but pool starvation SUPPRESSES volume (players hit 100% losses and leave), so a starved brand often
never reaches 50 trades and the drift alert stays silent. This monitor instead looks at the STRUCTURAL
pool signal (available budget vs stake) and low-volume all-loss streaks, so it fires early and loudly.

For each ACTIVE pool-mode brand it checks the current EAT day and raises:
  * POOL_STARVED   — available budget (amount-paid-reserved) < one minimum stake while trades happened
                     today. The pool literally cannot fund a single minimum win -> guaranteed 100% loss.
  * ALL_LOSS       — >= --min-decisions decided trades today with ZERO wins while turnover > 0.
  * BELOW_VIABLE   — (warning) available < min-viable (min_stake*max_mult/playerShare) with live demand;
                     wins are possible but throttled; the pool should be topped up.

Exit code is non-zero when any brand is in ALERT (POOL_STARVED/ALL_LOSS), so CI/the scheduler can act.
If TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS are set, an alert is also pushed to Telegram (same convention
as the payout-approvals bot). Read-only; no writes.

Usage:  DATABASE_URL=postgres://... python3 scripts/pool_health_monitor.py [--min-decisions 8] [--json]
"""
import os, sys, json, argparse, urllib.request, urllib.parse

PLAYER_SHARE = 0.15  # mirrors DEFAULT_POOL_KNOBS.playerShare (packages/shared/src/pool.ts)


def send_telegram(text: str) -> None:
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_ids = [c.strip() for c in (os.environ.get("TELEGRAM_CHAT_IDS") or "").split(",") if c.strip()]
    if not token or not chat_ids:
        return
    for chat_id in chat_ids:
        try:
            data = urllib.parse.urlencode({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
            req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
            urllib.request.urlopen(req, timeout=15).read()
        except Exception as e:  # never let alerting failure mask the exit code
            print(f"[warn] telegram send failed for chat {chat_id}: {e}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-decisions", type=int, default=8,
                    help="min decided trades today before an all-loss day is treated as an alert")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr); return 2
    import psycopg2
    conn = psycopg2.connect(url, connect_timeout=30); conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor()

    # One pass per active pool-mode brand: the LIVE pool state (current) + a ROLLING 2-hour window of
    # decisions/wins/turnover (by opened_at). The rolling window — not the whole EAT day — is what
    # drives alerts, so a brand that was just re-funded clears immediately instead of being flagged for
    # stale pre-remediation losses, and a genuine LIVE all-loss streak still pages.
    cur.execute("""
        with day as (select (now() at time zone 'Africa/Nairobi')::date as d)
        select s.slug,
               coalesce(g.min_stake, 0)                                  as min_stake,
               greatest(coalesce(g.max_multiplier, 1), 1)                as max_mult,
               coalesce(wp.amount_cents, 0)                              as amount,
               coalesce(wp.paid_cents, 0)                                as paid,
               coalesce(wp.reserved_cents, 0)                            as reserved,
               coalesce(dd.decisions, 0)                                 as decisions,
               coalesce(dd.wins, 0)                                      as wins,
               coalesce(dd.turnover, 0)                                  as turnover
          from sites s
          left join site_game_config g on g.site_id = s.id
          cross join day
          left join withdrawal_pool wp on wp.site_id = s.id and wp.trade_day = day.d
          left join (
              select d2.site_id,
                     count(*)                                        as decisions,
                     count(*) filter (where d2.decided_result='win')  as wins,
                     coalesce(sum(p.stake), 0)                        as turnover
                from position_decision d2
                join positions p on p.id = d2.position_id
               where p.opened_at >= now() - interval '2 hours'
               group by d2.site_id
          ) dd on dd.site_id = s.id
         where s.status = 'active' and s.pool_mode = true
         order by s.created_at
    """)

    report, alerts = [], []
    for slug, min_stake, max_mult, amount, paid, reserved, decisions, wins, turnover in cur.fetchall():
        min_stake = int(min_stake); amount = int(amount); paid = int(paid); reserved = int(reserved)
        decisions = int(decisions); wins = int(wins); turnover = int(turnover)
        available = max(0, amount - paid - reserved)
        min_viable = int(-(-(min_stake * float(max_mult)) // PLAYER_SHARE)) if min_stake else 0  # ceil
        brand = {"slug": slug, "amount": amount, "available": available, "min_stake": min_stake,
                 "min_viable": min_viable, "decisions": decisions, "wins": wins, "turnover": turnover,
                 "alerts": []}
        if decisions > 0 and available < min_stake:
            brand["alerts"].append(f"POOL_STARVED available={available} < min_stake={min_stake} "
                                   f"(cannot fund a single win; {decisions} trades in last 2h)")
        if turnover > 0 and decisions >= args.min_decisions and wins == 0:
            brand["alerts"].append(f"ALL_LOSS {decisions} trades, 0 wins in last 2h (turnover={turnover})")
        if turnover > 0 and available < min_viable and not brand["alerts"]:
            brand["alerts"].append(f"BELOW_VIABLE available={available} < min_viable={min_viable} (warning)")
        report.append(brand)
        for a in brand["alerts"]:
            alerts.append(f"{slug}: {a}")

    # An ALERT (not a mere warning) is POOL_STARVED or ALL_LOSS.
    hard = [a for a in alerts if "BELOW_VIABLE" not in a]

    if args.json:
        print(json.dumps({"alert": bool(hard), "warnings": [a for a in alerts if a not in hard],
                          "brands": report}, indent=2))
    else:
        for b in report:
            flag = "🚨" if any("BELOW_VIABLE" not in a for a in b["alerts"]) else ("⚠️" if b["alerts"] else "✅")
            print(f"{flag} {b['slug']:<13} avail={b['available']:>10} min_stake={b['min_stake']:>7} "
                  f"decisions={b['decisions']:>4} wins={b['wins']:>4} turnover={b['turnover']:>10}")
            for a in b["alerts"]:
                print(f"      - {a}")
        print("\nOVERALL:", "🚨 ALERT" if hard else "✅ healthy")

    if hard:
        send_telegram("🚨 <b>Invest254 pool starvation</b>\n" + "\n".join(hard) +
                      "\n\nPlayers may be losing 100%. Re-fund the pool / run a dynamic distribution.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
