/**
 * Marketer LIVE sessions (migration 0191): start, end, extend, and what a session earned.
 *
 * REPORTING ONLY. Attribution is untouched — `fn_pay_referral_commissions` writes
 * `deposit_commissions` for every deposit exactly as it did before, live or not. `earnedCents` here
 * is a QUESTION asked of commissions this marketer had already earned: which of them fall inside
 * this session's window. Reading this number changes nobody's pay; an operator decides what to do
 * with it. If per-session pay ever becomes the rule, that is a deliberate change to the money path.
 */
export interface LiveQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

export interface LiveSettings {
  enabled: boolean;
  sessionMinutes: number;
  marginMinutes: number;
  extendMinutes: number;
  /** 0 = unlimited. */
  maxSessionsDaily: number;
}

export interface LiveSession {
  id: string;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  streamUrl: string | null;
  marginMinutes: number;
  /** True while it is running: not ended, and not past its end time. */
  live: boolean;
  /** Commission this marketer earned on deposits inside the window, in KES cents. */
  earnedCents: number;
  /** How many deposits those commissions came from — the figure that makes the money legible. */
  deposits: number;
}

export interface LiveSessionStore {
  settings(siteId: string): Promise<LiveSettings>;
  saveSettings(siteId: string, patch: Partial<LiveSettings>): Promise<LiveSettings>;
  current(siteId: string, marketerId: string): Promise<LiveSession | null>;
  start(siteId: string, marketerId: string, streamUrl: string | null): Promise<LiveSession>;
  end(siteId: string, marketerId: string): Promise<LiveSession | null>;
  extend(siteId: string, marketerId: string): Promise<LiveSession | null>;
  history(siteId: string, marketerId: string, limit: number): Promise<LiveSession[]>;
}

const DEFAULTS: LiveSettings = {
  enabled: false, sessionMinutes: 60, marginMinutes: 10, extendMinutes: 30, maxSessionsDaily: 0,
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapSettings(x: Record<string, unknown>): LiveSettings {
  return {
    enabled: x.enabled === true,
    sessionMinutes: Number(x.session_minutes ?? DEFAULTS.sessionMinutes),
    marginMinutes: Number(x.margin_minutes ?? DEFAULTS.marginMinutes),
    extendMinutes: Number(x.extend_minutes ?? DEFAULTS.extendMinutes),
    maxSessionsDaily: Number(x.max_sessions_daily ?? DEFAULTS.maxSessionsDaily),
  };
}

function mapSession(x: Record<string, unknown>): LiveSession {
  const endedAt = x.ended_at ? iso(x.ended_at) : null;
  const endsAt = iso(x.ends_at);
  return {
    id: String(x.id),
    startedAt: iso(x.started_at),
    endsAt,
    endedAt,
    streamUrl: (x.stream_url as string | null) ?? null,
    marginMinutes: Number(x.margin_minutes ?? 10),
    live: endedAt === null && new Date(endsAt).getTime() > Date.now(),
    earnedCents: Math.max(0, Math.round(Number(x.earned_cents ?? 0))),
    deposits: Math.max(0, Math.round(Number(x.deposits ?? 0))),
  };
}

/**
 * A session row with its earnings attached.
 *
 * The window closes at `coalesce(ended_at, ends_at)` so a running session reports what it has earned
 * SO FAR rather than nothing, and the margin is the one stored ON THE SESSION — changing the brand
 * setting later must not restate what a past session earned.
 *
 * The join is on the DEPOSIT's own timestamp, not the commission row's: a commission written by a
 * retry or a reconcile sweep minutes later still belongs to the deposit that caused it.
 */
const SESSION_SELECT = `
  select s.*,
         coalesce(sum(c.commission_amount), 0) as earned_cents,
         count(c.id)                           as deposits
    from public.marketer_live_sessions s
    left join public.transactions t
      on t.site_id = s.site_id
     and t.kind = 'deposit' and t.status = 'success'
     and t.created_at >= s.started_at - make_interval(mins => s.margin_minutes)
     and t.created_at <= coalesce(s.ended_at, s.ends_at) + make_interval(mins => s.margin_minutes)
    left join public.deposit_commissions c
      on c.deposit_tx_id = t.id
     and c.beneficiary_user = s.marketer_id
`;

export function makePgLiveSessions(q: LiveQuerier): LiveSessionStore {
  async function settingsOf(siteId: string): Promise<LiveSettings> {
    const r = await q.query(`select * from public.site_live_settings where site_id = $1`, [siteId]);
    return r.rows.length ? mapSettings(r.rows[0]!) : { ...DEFAULTS };
  }

  async function oneSession(siteId: string, marketerId: string, openOnly: boolean): Promise<LiveSession | null> {
    const r = await q.query(
      `${SESSION_SELECT}
        where s.site_id = $1 and s.marketer_id = $2 ${openOnly ? 'and s.ended_at is null' : ''}
        group by s.id
        order by s.started_at desc
        limit 1`,
      [siteId, marketerId],
    );
    return r.rows.length ? mapSession(r.rows[0]!) : null;
  }

  return {
    settings: settingsOf,

    async saveSettings(siteId, patch) {
      const cur = await settingsOf(siteId);
      const next = { ...cur, ...patch };
      await q.query(
        `insert into public.site_live_settings
           (site_id, enabled, session_minutes, margin_minutes, extend_minutes, max_sessions_daily, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (site_id) do update set
           enabled = excluded.enabled, session_minutes = excluded.session_minutes,
           margin_minutes = excluded.margin_minutes, extend_minutes = excluded.extend_minutes,
           max_sessions_daily = excluded.max_sessions_daily, updated_at = now()`,
        [siteId, next.enabled, next.sessionMinutes, next.marginMinutes, next.extendMinutes, next.maxSessionsDaily],
      );
      return next;
    },

    current: (siteId, marketerId) => oneSession(siteId, marketerId, true),

    async start(siteId, marketerId, streamUrl) {
      const s = await settingsOf(siteId);
      if (!s.enabled) throw new Error('LIVE_DISABLED');

      // Expire anything already open and past its time, so a forgotten session does not block the
      // next one. This is also what makes `uq_live_session_open` safe to rely on below.
      await q.query(
        `update public.marketer_live_sessions set ended_at = ends_at
          where site_id = $1 and marketer_id = $2 and ended_at is null and ends_at <= now()`,
        [siteId, marketerId],
      );

      const open = await oneSession(siteId, marketerId, true);
      if (open) throw new Error('ALREADY_LIVE');

      if (s.maxSessionsDaily > 0) {
        const used = await q.query(
          `select count(*)::int as n from public.marketer_live_sessions
            where site_id = $1 and marketer_id = $2 and started_at >= date_trunc('day', now())`,
          [siteId, marketerId],
        );
        if (Number(used.rows[0]?.n ?? 0) >= s.maxSessionsDaily) throw new Error('DAILY_LIMIT_REACHED');
      }

      await q.query(
        `insert into public.marketer_live_sessions
           (site_id, marketer_id, ends_at, stream_url, margin_minutes)
         values ($1, $2, now() + make_interval(mins => $3), nullif(btrim($4), ''), $5)`,
        [siteId, marketerId, s.sessionMinutes, streamUrl ?? '', s.marginMinutes],
      );
      const created = await oneSession(siteId, marketerId, true);
      if (!created) throw new Error('START_FAILED');
      return created;
    },

    async end(siteId, marketerId) {
      await q.query(
        `update public.marketer_live_sessions set ended_at = now()
          where site_id = $1 and marketer_id = $2 and ended_at is null`,
        [siteId, marketerId],
      );
      return oneSession(siteId, marketerId, false);
    },

    async extend(siteId, marketerId) {
      const s = await settingsOf(siteId);
      const r = await q.query(
        `update public.marketer_live_sessions
            set ends_at = ends_at + make_interval(mins => $3)
          where site_id = $1 and marketer_id = $2 and ended_at is null
          returning id`,
        [siteId, marketerId, s.extendMinutes],
      );
      if (!r.rows.length) return null;
      return oneSession(siteId, marketerId, true);
    },

    async history(siteId, marketerId, limit) {
      const r = await q.query(
        `${SESSION_SELECT}
          where s.site_id = $1 and s.marketer_id = $2
          group by s.id
          order by s.started_at desc
          limit $3`,
        [siteId, marketerId, limit],
      );
      return r.rows.map(mapSession);
    },
  };
}
