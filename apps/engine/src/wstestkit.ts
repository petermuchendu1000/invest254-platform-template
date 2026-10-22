/**
 * Test-only WebSocket client for the engine's streaming tests (not imported by any server path).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every engine WS test used to carry its own `waitFor`/`collect`, each with its own ceiling, and
 * every one of them had the same two defects:
 *
 *  1. **A fixed deadline sized for an idle machine.** `multiengine.candles.test.ts` waited at most
 *     30_000 ms for a condition that costs 24_000 ms unloaded — an 0.80 actual/ceiling ratio, i.e.
 *     a red suite the first time the runner is busy. A ceiling is not an assertion: waiting longer
 *     for the SAME condition loses no rigour, so ceilings here are derived from the measured idle
 *     cost of the thing being waited for (see `budget`) rather than guessed at.
 *
 *  2. **A listener attached after the test had already decided to wait.** A frame that arrived
 *     between "I want the next X" and `ws.on("message", …)` was lost for ever, and a frame that had
 *     already arrived was invisible to anything but a hand-written pre-scan. That is the race that
 *     broke deploys 170 and 171 (`77134 !== 77133`, and a settle-index tick read as `undefined`).
 *
 * The cure for (2) is structural rather than careful: this client owns ONE `message` listener,
 * installed in the constructor, which appends every frame to `msgs` and then re-evaluates every
 * pending waiter. A waiter therefore sees the whole log the instant it is created — there is no
 * window between scanning and attaching, because nothing attaches. "Scan before attach" is not a
 * property each call site has to remember; it is the only thing that can happen.
 *
 * Reading frames at a FIXED MOMENT is the other half of the same bug: `of("balance").at(-1)` right
 * after an unrelated `await` samples whatever has been parsed so far, and the frame under test is
 * routinely a separate, later send (a post-open balance follows `digit_opened` behind a wallet
 * round-trip). Await the condition — `waitWhere`, or `waitUntil` — and then assert on the frame the
 * wait returned. The assertion does not change; only the moment it is allowed to run does.
 */
import { WebSocket } from "ws";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How much slower than an idle machine a contended one is assumed to be.
 *
 * Measured on this repo at ~3x CPU oversubscription (busy loops for 3 × core count, 4 cores):
 * game.digits.ws 18s → 65s, game.multipliers.ws 9.7s → 34s and multiengine 45s → 156s, i.e. ~3.5x
 * for the timer-bound files; the CPU-bound symbol-chain warms in multiengine.candles stretched
 * furthest, 17.4s → 135s on its slowest test (~7.8x). 12 clears the worst of those with roughly 2x
 * to spare, which is the right side to err on: a ceiling costs nothing until something is already
 * broken, and a ceiling that is too tight costs a deploy.
 */
export const LOAD_FACTOR = 12;

/** No ceiling below this, so a sub-millisecond round-trip still gets a usable grace period. */
export const MIN_CEILING_MS = 15_000;

/**
 * A ceiling for a condition that costs `idleMs` on an unloaded machine.
 *
 * Call sites state the measured idle cost of what they are waiting for and get a ceiling scaled off
 * it, so there is one number to tune (`LOAD_FACTOR`) instead of a 30_000 repeated down the file.
 */
export const budget = (idleMs: number) => Math.max(MIN_CEILING_MS, Math.ceil(idleMs * LOAD_FACTOR));

/** A ceiling for "n ticks of a stream that ticks every `tickRateMs`". */
export const ticksBudget = (n: number, tickRateMs: number) => budget(n * tickRateMs);

/** A protocol round-trip: a request and its reply, or the next frame of an already-live stream. */
export const REPLY_MS = budget(1_500);

/**
 * A contract that has to settle: the engine waits for the instrument's own 1s tick and a wallet
 * round-trip behind it. Idle cost is 1–3s across game.digits.ws / game.multipliers.ws.
 */
export const SETTLE_MS = budget(3_000);

/**
 * Anything behind a cold symbol-chain warm (`SymbolHistories.warm`), which walks a day's chain for
 * a symbol the brand has not drawn yet. Measured idle cost in multiengine.candles.test.ts: 5s for
 * a bare `candles` fetch, up to 24s for the seed-then-stream quote test, which warms while the
 * brand is already ticking. Sized off the worst of those, not the best.
 */
export const WARM_MS = budget(25_000);

type Frame = any;

/**
 * A WS client that logs every frame it has ever received and lets tests await CONDITIONS over that
 * log. `mark()`/`since()` exist so a test can still say "nothing of this kind arrived after here",
 * which is a silence assertion and must not be satisfied by frames from before the mark.
 */
export class WsTestClient {
  readonly ws: WebSocket;
  readonly msgs: Frame[] = [];
  private readonly waiters = new Set<() => void>();
  private closedWhy: string | null = null;

  constructor(readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      let m: Frame;
      try { m = JSON.parse(String(raw)); } catch { return; }
      this.msgs.push(m);
      this.wake();
    });
    // A waiter on a dead socket can never be satisfied: fail it with the reason instead of sitting
    // on the ceiling and reporting a timeout that says nothing about why.
    this.ws.on("close", (code: number) => { this.closedWhy = `socket closed (${code})`; this.wake(); });
    this.ws.on("error", (err: Error) => { this.closedWhy ??= `socket error: ${err.message}`; this.wake(); });
  }

  private wake(): void { for (const w of [...this.waiters]) w(); }

  /** Already-open sockets resolve immediately: `once("open")` on one would never fire. */
  open(timeoutMs = REPLY_MS): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout opening ${this.url}`)), timeoutMs);
      this.ws.once("open", () => { clearTimeout(t); res(); });
      this.ws.once("error", (e) => { clearTimeout(t); rej(e); });
    });
  }

  send(type: string, data: unknown): void { this.ws.send(JSON.stringify({ type, data })); }

  /** Every frame of `type` received so far, oldest first. */
  of(type: string): Frame[] { return this.msgs.filter((m) => m.type === type); }

  /** A cursor into the frame log: "everything from here on" for `since` and `collect`. */
  mark(): number { return this.msgs.length; }

  /** Frames after `cursor`, optionally of one type. Use for silence assertions. */
  since(cursor: number, type?: string): Frame[] {
    const tail = this.msgs.slice(cursor);
    return type === undefined ? tail : tail.filter((m) => m.type === type);
  }

  /**
   * The one primitive. Resolves as soon as `pred` holds over the frame log — evaluated immediately,
   * then again after every frame — and rejects with `what` in the message if the ceiling passes or
   * the socket dies first.
   */
  waitUntil<T>(pred: () => T | false | undefined | null, what: string, timeoutMs = REPLY_MS): Promise<T> {
    const first = pred();
    if (first) return Promise.resolve(first);
    return new Promise<T>((res, rej) => {
      const settle = (fn: () => void) => { clearTimeout(timer); this.waiters.delete(check); fn(); };
      const check = () => {
        const hit = pred();
        if (hit) return settle(() => res(hit));
        if (this.closedWhy) settle(() => rej(new Error(`${this.closedWhy} while waiting for ${what}`)));
      };
      const timer = setTimeout(() => settle(() => rej(new Error(`timeout after ${timeoutMs}ms waiting for ${what}`))), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  /** The first frame of `type` ever received (or the next one to arrive). */
  waitFor(type: string, timeoutMs = REPLY_MS): Promise<Frame> {
    return this.waitUntil(() => this.msgs.find((m) => m.type === type), type, timeoutMs);
  }

  /**
   * The first frame of `type` that SAYS something — "the balance frame that shows the debit", "the
   * tick that reached the committed settle index" — rather than merely the first of its type.
   */
  waitWhere(type: string, pred: (m: Frame) => boolean, timeoutMs = REPLY_MS): Promise<Frame> {
    return this.waitUntil(() => this.msgs.find((m) => m.type === type && pred(m)), `a matching ${type}`, timeoutMs);
  }

  /** The next frame of `type` to arrive AFTER this call, ignoring the ones already logged. */
  next(type: string, timeoutMs = REPLY_MS): Promise<Frame> {
    const from = this.mark();
    return this.waitUntil(() => this.since(from, type)[0], `the next ${type}`, timeoutMs);
  }

  /**
   * Send a request and resolve on its reply — or on an `error`, so a refused request fails the test
   * on the assertion rather than on a timeout. Only frames that arrive after the send count, so a
   * stale `error` logged earlier in the test cannot be mistaken for this request's answer.
   */
  ask(type: string, data: unknown, expect: string, timeoutMs = REPLY_MS): Promise<Frame> {
    const from = this.mark();
    const got = this.waitUntil(
      () => this.since(from).find((m) => m.type === expect || m.type === "error"),
      `${expect} (or an error) in reply to ${type}`,
      timeoutMs,
    );
    this.send(type, data);
    return got;
  }

  /**
   * Every frame of `types` from this call onwards, until `done` has enough of them.
   *
   * Counted from the call, not from the attach, so nothing can slip through in between — and not
   * from the start of the log either, or "wait for five more ticks" would be satisfied instantly by
   * ticks that arrived before the test asked.
   */
  collect(types: readonly string[], done: (seen: Frame[]) => boolean, what: string, timeoutMs = REPLY_MS): Promise<Frame[]> {
    const from = this.mark();
    return this.waitUntil(() => {
      const seen = this.since(from).filter((m) => types.includes(m.type));
      return done(seen) ? seen : false;
    }, what, timeoutMs);
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}
