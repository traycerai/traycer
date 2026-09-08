import { useEffect, useState } from "react";

/**
 * `true` once wall-clock time has reached `atMs` (an epoch-ms instant), and
 * `false` while it is still ahead or when `atMs` is `null` (nothing pending).
 *
 * The sibling of `useLoadDeadline`, and deliberately not the same hook. That
 * one starts a BUDGET when a key becomes current in the calling component,
 * which is the right anchor for a wait the surface itself began. This one
 * takes the instant the wait falls due, because its anchor is recorded outside
 * React - in a store that outlives any one mount - so a component that mounts
 * into a wait already in progress has to inherit the elapsed time rather than
 * restart it. Restarting it is how a surface reopened after a long stall shows
 * a fresh spinner for the whole budget again.
 *
 * One `setTimeout` for the REMAINING interval, not a poll: the answer changes
 * once.
 *
 * The answer is DERIVED from a clock sample rather than stored as a flag, and
 * the sample is taken in `useState`'s initialiser and then only ever advanced
 * by the timer's own callback. Two things fall out of that shape, and both are
 * the reason for it:
 *
 *  - A deadline already in the past is answered by the FIRST render, with no
 *    effect and no second commit - which is what a component mounting into an
 *    old stall needs, and what a stored flag could only reach by setting state
 *    from the effect body (`react-hooks/set-state-in-effect`, and a frame of
 *    wrong answer before it lands).
 *  - A re-arm is flash-free: on the render where `atMs` moves to a later
 *    instant, the same sample is already behind it, so the answer is `false`
 *    immediately with no reset effect and no window in which the previous
 *    wait's verdict describes the new one.
 */
export function useDeadlineReached(atMs: number | null): boolean {
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const reached = atMs !== null && observedAt >= atMs;

  useEffect(() => {
    // Nothing to wait for, or the sample already covers it - and in the second
    // case this also disarms the timer that produced the answer.
    if (atMs === null || reached) return;
    const timer = window.setTimeout(
      () => {
        setObservedAt(Date.now());
      },
      // Clamped because the deadline can be behind an ADVANCED sample: the
      // stored sample is only as fresh as the last firing, so a deadline that
      // fell due between firings is late rather than impossible.
      Math.max(0, atMs - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [atMs, reached]);

  return reached;
}
