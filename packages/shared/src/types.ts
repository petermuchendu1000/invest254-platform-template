export type Direction = "buy" | "sell";
export type PositionStatus = "open" | "settled" | "void";
export type PositionResult = "win" | "loss" | "void";

export interface Tick {
  t: number;
  rate: number;
  delta: number;
  /**
   * This tick was INVENTED by the client, not sent by the engine.
   *
   * The web client pre-fills its tick buffer with a smooth made-up curve so the classic shell's
   * line is full on load instead of growing in from the right. That is a backdrop for a game, and
   * it is fine there; it is not a quote. Anything that turns a tick into a PRICE must refuse one of
   * these, because a fabricated rate run through the day's real anchor prints a price the server
   * never sent: on a terminal that is a false print on a broker's chart, and it was drawing candles
   * tens of points away from the market.
   *
   * Absent on every tick the engine sends, which is what makes the flag safe to trust.
   */
  synthetic?: true;
}

export interface OpenPositionInput {
  userId: string;
  stakeCents: number;
  direction: Direction;
  durationS: number;
  openedAtMs: number;
}

export interface Outcome {
  result: Extract<PositionResult, "win" | "loss">;
  multiplier: number;   // 1.0 on loss-base; >1..=max on win
  payoutCents: number;  // stake*multiplier on win, else 0
  pnlCents: number;     // payout - stake
  entryRate: number;
  exitRate: number;
  signedMove: number;
}
