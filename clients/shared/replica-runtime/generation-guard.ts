/**
 * One generation guard, replacing the hand-rolled copies.
 * Applying one of those writes a superseded host's answer into the live replica.
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
