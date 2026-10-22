import { createCipheriv, createHmac } from "node:crypto";

/**
 * Deterministic, provably-fair pseudo-random number generator.
 *
 * Outcomes are derived from HMAC-SHA256(serverSeed, label). The serverSeed is
 * committed in advance (publish sha256(serverSeed)) and revealed later, so any
 * party can recompute and verify every outcome — see docs/02-game-engine.md §4.
 *
 * The HMAC digest is consumed as a stream of 48-bit blocks, each mapped to a
 * uniform float in [0, 1). The stream re-keys with an incrementing counter so it
 * never runs out of entropy for a given (seed, label).
 */
export class SeededRng {
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;

  constructor(private readonly serverSeed: string, private readonly label: string) {
    if (!serverSeed) throw new Error("serverSeed is required");
    if (!label) throw new Error("label is required");
  }

  private refill(): void {
    this.buffer = createHmac("sha256", this.serverSeed)
      .update(`${this.label}:${this.counter++}`)
      .digest();
    this.offset = 0;
  }

  /** Uniform float in [0, 1) with 48 bits of resolution. */
  next(): number {
    if (this.offset + 6 > this.buffer.length) this.refill();
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * 256 + this.buffer[this.offset + i]!;
    this.offset += 6;
    return v / 2 ** 48; // 48-bit mantissa, strictly < 1
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Standard normal via Box–Muller (uses two uniforms). */
  normal(): number {
    let u1 = this.next();
    if (u1 < 1e-12) u1 = 1e-12; // avoid log(0)
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/**
 * Bulk deterministic keystream — same uniforms as SeededRng, generated hundreds of times faster.
 *
 * SeededRng re-keys an HMAC every 5 draws, which costs ~2.6us per digest. That is the right trade
 * for the few draws an outcome needs, but the price curve draws ~260k per day: 139ms, and 59s to
 * reconstruct a year of history for one brand. Here the seed is expanded ONCE into an AES-256-CTR
 * keystream, which the same work takes 0.8ms to produce — a year in under a second.
 *
 * WHY THIS STILL HAS TO BE A CRYPTOGRAPHIC GENERATOR. The obvious speed-up is a small non-crypto
 * PRNG (xoshiro, PCG). It would be catastrophic here: the curve is drawn on screen in real time, so
 * its output is public as it is generated, and those generators' internal state can be recovered
 * from a handful of outputs — a player could then compute the REST of the day's prices. AES-CTR
 * leaks nothing about its key, so the curve stays unpredictable until the seed is revealed.
 *
 * Determinism and auditability are unchanged: key = HMAC-SHA256(serverSeed, "<label>:ks1") and the
 * counter starts at zero, both standard primitives, so anyone holding the revealed seed recomputes
 * the identical stream.
 */
export class SeedKeystream {
  private readonly buf: Buffer;
  private offset = 0;

  /** `uniforms` is how many draws to expand up front; past it, next() throws rather than repeat. */
  constructor(serverSeed: string, label: string, uniforms: number) {
    if (!serverSeed) throw new Error("serverSeed is required");
    if (!label) throw new Error("label is required");
    if (!Number.isInteger(uniforms) || uniforms <= 0) throw new Error("uniforms must be a positive integer");
    const key = createHmac("sha256", serverSeed).update(`${label}:ks1`).digest();
    const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
    this.buf = Buffer.concat([cipher.update(Buffer.alloc(uniforms * 6)), cipher.final()]);
  }

  /** Uniform float in [0, 1) with 48 bits of resolution — identical semantics to SeededRng.next(). */
  next(): number {
    if (this.offset + 6 > this.buf.length) throw new Error("SeedKeystream exhausted");
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * 256 + this.buf[this.offset + i]!;
    this.offset += 6;
    return v / 2 ** 48;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
