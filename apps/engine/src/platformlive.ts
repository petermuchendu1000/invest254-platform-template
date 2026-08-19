/**
 * Platform live feed — real-time deposit push for the cross-brand platform console (docs/24).
 *
 * Deposits are confirmed in the REST API (M-Pesa STK callback flips a `transactions` row to
 * status='success'), a different process from this WebSocket engine. Migration 0071 fires
 * `pg_notify('deposit_confirmed', <json>)` from an AFTER trigger the moment a deposit first
 * reaches success; this notifier LISTENs on that channel and hands each parsed event to the
 * engine, which fans it out to connected platform_superadmin sockets (the `platform` channel
 * in multiengine.ts).
 *
 * Mirrors `walletnotify.ts`: a dedicated LISTEN connection with reconnect-on-error backoff.
 */

export const DEPOSIT_CHANNEL = "deposit_confirmed";

/** A confirmed deposit, as broadcast to the platform console. Money is integer cents. */
export interface DepositEvent {
  siteId: string;
  userId: string;
  username: string;
  amountCents: number;
  txId: string;
  atMs: number;
}

/** Minimal LISTEN surface — `pg.Pool.connect()` satisfies this; kept structural for tests. */
export interface DepositListenClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  release?(err?: boolean): void;
}
export type DepositListenConnector = () => Promise<DepositListenClient>;

export interface DepositNotifierOptions {
  /** Opens a dedicated connection for LISTEN (e.g. `() => listenPool.connect()`). */
  connect: DepositListenConnector;
  /** Invoked with each confirmed deposit; the caller fans it out to platform sockets. */
  onDeposit: (dep: DepositEvent) => void;
  /** Reconnect backoff after a LISTEN connection error. Default 5s. */
  reconnectMs?: number;
  onError?: (err: Error, ctx: string) => void;
}

function parseDeposit(payload: string | undefined): DepositEvent | null {
  if (!payload) return null;
  try {
    const o = JSON.parse(payload) as Record<string, unknown>;
    const siteId = String(o.siteId ?? "");
    const txId = String(o.txId ?? "");
    const amountCents = Number(o.amountCents);
    if (!siteId || !txId || !Number.isFinite(amountCents)) return null;
    return {
      siteId,
      userId: String(o.userId ?? ""),
      username: String(o.username ?? ""),
      amountCents: Math.round(amountCents),
      txId,
      atMs: Number.isFinite(Number(o.atMs)) ? Number(o.atMs) : Date.now(),
    };
  } catch {
    return null;
  }
}

/** LISTENs `deposit_confirmed` and invokes `onDeposit` for each parsed event. */
export class DepositNotifier {
  private client: DepositListenClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly opts: DepositNotifierOptions) {}

  /** Arm the LISTEN. Resolves once the initial attempt completes (reconnects continue in background). */
  async init(): Promise<void> {
    await this.arm();
  }

  private report(err: Error, ctx: string): void {
    this.opts.onError?.(err, ctx);
  }

  private drop(): void {
    const c = this.client;
    this.client = undefined;
    try {
      c?.release?.(true);
    } catch {
      /* ignore release errors on a broken connection */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const ms = this.opts.reconnectMs ?? 5_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.arm();
    }, ms);
    this.reconnectTimer.unref?.();
  }

  private async arm(): Promise<void> {
    if (this.stopped || this.client) return;
    try {
      const client = await this.opts.connect();
      this.client = client;
      client.on("notification", (msg) => {
        if (msg.channel !== DEPOSIT_CHANNEL) return;
        const dep = parseDeposit(msg.payload);
        if (dep) this.opts.onDeposit(dep);
      });
      client.on("error", (err) => {
        this.report(err, "listen");
        this.drop();
        this.scheduleReconnect();
      });
      await client.query(`listen ${DEPOSIT_CHANNEL}`);
    } catch (err) {
      this.report(err as Error, "connect");
      this.drop();
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.drop();
  }
}
