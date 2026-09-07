import { useEffect, useState } from "react";

/** true after budgetMs on the current non-null key. Store the elapsed key, not a boolean, so a key change re-arms immediately. */
export function useLoadDeadline(key: string | null, budgetMs: number): boolean {
  // The EPISODE, not just the key: a wait for "host-x", a disarm (`null`), and a second wait for "host-x" are two different waits, and the second must get a fresh budget.
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
