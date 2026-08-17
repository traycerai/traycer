import { useEffect, useState } from "react";

/**
 * The epic's ONE loading deadline (invariant 6). `true` once `budgetMs` has
 * elapsed since `key` became its current non-null value.
 *
 * `key` is the identity of the thing being waited FOR - a hostId, or a
 * hostId+attempt pair. Pass `null` to disarm (nothing is pending). Changing
 * the key re-arms the budget from zero, because a different key is a
 * different wait.
 *
 * The elapsed KEY is stored rather than a boolean, which is what makes the
 * re-arm free and correct: on the render where the key changes, the stored
 * key no longer matches and this answers `false` immediately, with no reset
 * effect and no window where a stale `true` describes a fresh wait. A boolean
 * plus a reset effect would report the previous wait's verdict for exactly
 * one commit - long enough to flash a terminal state over a load that had
 * just started.
 *
 * Deliberately one `setTimeout` and not a poll: the answer changes once.
 */
export function useLoadDeadline(key: string | null, budgetMs: number): boolean {
  // The EPISODE, not just the key: a wait for "host-x", a disarm (`null`),
  // and a second wait for "host-x" are two different waits, and the second
  // must get a fresh budget. Storing only the elapsed KEY made the second
  // wait read the first one's verdict on its opening frame. The episode
  // advances during render on every key change (the derived-state idiom), so
  // the re-arm stays flash-free: on the change render the stored episode no
  // longer matches, and the answer is `false` with no reset effect.
  const [episode, setEpisode] = useState(0);
  const [prevKey, setPrevKey] = useState<string | null>(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setEpisode((value) => value + 1);
  }
  const [elapsedEpisode, setElapsedEpisode] = useState(-1);

  useEffect(() => {
    if (key === null) return;
    const timer = window.setTimeout(() => {
      setElapsedEpisode(episode);
    }, budgetMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [key, episode, budgetMs]);

  return key !== null && elapsedEpisode === episode;
}
