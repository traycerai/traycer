import { useEffect, useState } from "react";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

const NOW_TICK_INTERVAL_MS = 60_000;

/**
 * Wall-clock millisecond timestamp that re-renders the consuming component
 * once a minute so relative-time labels stay fresh while settings is open.
 */
export function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowMs(Date.now());
    }, NOW_TICK_INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
    };
  }, []);
  return nowMs;
}

export function useLocalHostSnapshot(
  runnerHost: IRunnerHost,
): LocalHostSnapshot | null {
  const [snapshot, setSnapshot] = useState<LocalHostSnapshot | null>(() => {
    let initial: LocalHostSnapshot | null = null;
    const probe = runnerHost.onLocalHostChange((next) => {
      initial = next;
    });
    probe.dispose();
    return initial;
  });
  useEffect(() => {
    const subscription = runnerHost.onLocalHostChange((next) => {
      setSnapshot(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost]);
  return snapshot;
}
