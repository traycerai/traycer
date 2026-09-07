import { useLayoutEffect } from "react";

/** A count, not a boolean, because two blocking surfaces can overlap and the first one to unmount must not hand
 * the app back while the second is still up. */
let claims = 0;

/** Declares that a surface is blocking the app underneath it, and returns the release. Paired calls only - a
 * claim that is never released leaves the app permanently unreachable to anything that asks. */
export function claimBlockingLayer(): () => void {
  claims += 1;
  let released = false;
  return () => {
    // Idempotent because an effect cleanup can be invoked more than once under a remount, and a double release
    // would decrement a count this claim only ever incremented once.
    if (released) return;
    released = true;
    claims -= 1;
  };
}

export function blockingLayerClaimed(): boolean {
  return claims > 0;
}

/** For blocking surfaces that do not go through the dismissable-layer primitive's modal machinery - the ones
 * that implement containment themselves, by inerting a subtree rather than by making the whole document inert. */
export function useBlockingLayerClaim(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    return claimBlockingLayer();
  }, [active]);
}
