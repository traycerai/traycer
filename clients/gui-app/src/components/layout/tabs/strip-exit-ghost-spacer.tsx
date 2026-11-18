import { animate, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import type { StripExitGhost } from "./strip-exit-ghosts";

const GHOST_CLOSE_S = 0.24;
const GHOST_EASE = [0.4, 0, 0.2, 1] as const;

/**
 * Holds a closed slot's space, then shrinks it to nothing so the strip closes
 * the gap. See `strip-exit-ghosts.ts` for how its width is found.
 */
export function StripExitGhostSpacer(props: {
  readonly ghost: StripExitGhost;
  readonly onSettled: (key: string) => void;
}) {
  const { ghost, onSettled } = props;
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const reduceMotion = useReducedMotion() === true;
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    if (reduceMotion) {
      onSettled(ghost.key);
      return;
    }
    const closing = animate(
      node,
      { width: [ghost.width, 0] },
      { duration: GHOST_CLOSE_S, ease: GHOST_EASE },
    );
    let cancelled = false;
    void closing.finished.then(
      () => {
        if (!cancelled) onSettled(ghost.key);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      closing.stop();
      // StrictMode's second run starts the close over from the full width.
      node.style.width = `${ghost.width}px`;
    };
  }, [ghost.key, ghost.width, onSettled, reduceMotion]);
  return (
    <span
      ref={nodeRef}
      aria-hidden
      data-strip-exit-ghost={ghost.key}
      className="block shrink-0 self-stretch"
      style={{ width: ghost.width }}
    />
  );
}
