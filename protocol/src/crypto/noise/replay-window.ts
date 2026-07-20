import { NoiseReplayError } from "./errors";

/**
 * Anti-replay sliding window (the RFC 6479 / IPsec-ESP scheme, expressed with a
 * BigInt bitmask so 64-bit counters need no special-casing).
 *
 * `highest` is the largest counter that has been *accepted*. `bitmask` records,
 * for each of the `size` counters ending at `highest`, whether it has been seen
 * (bit 0 corresponds to `highest`, bit `d` to `highest - d`). A frame is
 * acceptable iff its counter is newer than `highest`, or within the window and
 * not yet marked; anything older than the window is rejected.
 *
 * Discipline (security-gate bar #3): `check()` is a side-effect-free predicate
 * run *before* AEAD decryption — cheap replay/DoS rejection. `commit()` mutates
 * the window and is called *only after* the frame authenticates. A forged frame
 * can therefore never advance the window and starve honest frames.
 */
export class ReplayWindow {
  private highest = -1n;
  private bitmask = 0n;
  private readonly size: bigint;
  private readonly mask: bigint;

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new NoiseReplayError("replay window size must be a positive integer");
    }
    this.size = BigInt(size);
    this.mask = (1n << this.size) - 1n;
  }

  /** True if `counter` may be accepted (not a replay, not older than the window). */
  check(counter: bigint): boolean {
    if (counter < 0n) {
      return false;
    }
    if (this.highest < 0n) {
      return true;
    }
    if (counter > this.highest) {
      return true;
    }
    const distance = this.highest - counter;
    if (distance >= this.size) {
      return false;
    }
    return ((this.bitmask >> distance) & 1n) === 0n;
  }

  /**
   * Record `counter` as accepted. Call ONLY after `check(counter)` returned true
   * and the frame authenticated. Advancing the window shifts the bitmask so that
   * counters scrolling out of range are forgotten (and thus treated as replays
   * if they reappear).
   */
  commit(counter: bigint): void {
    if (!this.check(counter)) {
      throw new NoiseReplayError(
        `cannot commit rejected frame counter: ${counter}`,
      );
    }
    if (this.highest < 0n) {
      this.highest = counter;
      this.bitmask = 1n;
      return;
    }
    if (counter > this.highest) {
      const shift = counter - this.highest;
      this.bitmask = ((this.bitmask << shift) | 1n) & this.mask;
      this.highest = counter;
      return;
    }
    const distance = this.highest - counter;
    this.bitmask |= 1n << distance;
  }
}
