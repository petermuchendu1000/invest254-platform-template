import type { Tick } from '@invest254/shared/types';

export type { Tick };

/** WS envelope (engine: { type, data, ts }). */
export interface Envelope {
  type: string;
  data: unknown;
  ts: number;
}

export interface HelloData {
  serverTime: number;
  serverSeedHash: string;
  tradeDate: string;
  gameConfig: {
    minStakeCents: number;
    maxMultiplier: number;
    defaultDurationS: number;
    tickRateMs: number;
    /** Whether the engine will accept a manual close on this brand (false in pool mode). Absent on
     *  an engine that predates the flag, which is read as "no", because a close control that
     *  cannot work is worse than one that is not there. */
    earlyCloseEnabled?: boolean;
    /**
     * The brand's SPREAD, per side, in curve-value units.
     *
     * The move a trader has to make before a position is worth its stake, which is what the
     * continuous payout is built on and where the terminal's whole edge lives (settle.ts: "`cost`
     * is economically the SPREAD"). It is what lets this client quote MetaTrader's Bid and Ask
     * instead of one number: the engine has always charged it, and the ticket simply never showed
     * it.
     *
     * Null on a brand with no price axis, and absent on an engine that predates the field. Both
     * read as "this brand quotes one price", which is what every brand did before this.
     */
    spread?: { buy: number; sell: number } | null;
  };
}

export interface FairnessData {
  serverSeedHash: string;
  tradeDate: string;
}

export interface OnlineData {
  count: number;
}

export type ConnStatus = 'connecting' | 'open' | 'closed';
