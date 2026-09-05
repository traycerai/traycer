/**
 * One generation guard, replacing the hand-rolled copies.
 *
 * The problem it solves: a store closes a stream and opens a replacement, and
 * frames from the old socket are still in flight. Applying one of those writes
 * a superseded host's answer into the live replica. The existing fix is
 * correct and is written out by hand twice - `chat-session-store.ts` wraps
 * thirty callbacks one at a time with `if (!isCurrentStream(gen)) return;`, and
 * the terminal store does the same again. That is ~145 lines of pure
 * boilerplate per copy, and the bug it prevents returns the moment someone adds
 * a thirty-first handler and forgets the line.
 *
 * The guard is a plain counter rather than a token object because the check has
 * to be cheap enough to sit in front of every frame, and because a captured
 * number is the one thing a closure can hold without keeping the superseded
 * stream alive.
 */

export interface GenerationGuard {
  /** The generation currently accepted. Starts at 0. */
  current(): number;
  /**
   * Retire the current generation and return the new one. The caller passes the
   * returned value into the handlers it wires up for the replacement stream.
   */
  next(): number;
  /** Whether frames stamped `generation` may still be applied. */
  isCurrent(generation: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    current(): number {
      return generation;
    },
    next(): number {
      generation += 1;
      return generation;
    },
    isCurrent(candidate: number): boolean {
      return candidate === generation;
    },
  };
}

/**
 * Wrap one handler so it is inert once its generation is retired.
 *
 * Deliberately per-handler rather than a bulk object mapper: the two existing
 * copies wrap heterogeneous callbacks whose parameter types differ per frame,
 * and a mapped-type wrapper that preserved all thirty signatures would trade
 * boilerplate for a type-level construct nobody can read at the call site. The
 * unification win is that the CHECK exists once - not that the wiring becomes a
 * one-liner.
 *
 * Returns a handler with the same signature, so it drops into an existing
 * callbacks object with no other change.
 */
export function guardHandler<TArgs extends unknown[]>(
  guard: GenerationGuard,
  generation: number,
  handler: (...args: TArgs) => void,
): (...args: TArgs) => void {
  return (...args: TArgs): void => {
    if (!guard.isCurrent(generation)) return;
    handler(...args);
  };
}
