import { useEffect, useState } from "react";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Wall-clock millisecond timestamp that re-renders the consuming component on
 * a fixed interval.
 *
 * The interval is REQUIRED rather than defaulted, because the two callers want
 * it for opposite reasons and neither number would be a sane default for the
 * other. Relative-time labels ("last seen 4 minutes ago") only need to stop
 * being wrong eventually, so a minute is generous. A holder probe's five-second
 * proof (`LOCAL_LIVENESS_PROOF_MS`) is a DEADLINE, and a clock coarser than the
 * thing it measures cannot enforce one — at a minute, a lifecycle gate would
 * outlive its evidence by up to fifty-five seconds on a host that is already
 * unreachable. A caller that has to think about which number it needs is the
 * point of taking the parameter.
 *
 * This is also the only sanctioned way to read a moving clock in a render: a
 * `Date.now()` call during render is impure and, worse, does not re-render on
 * its own, so a component whose only remaining input is the passage of time
 * would simply stop updating.
 */
export function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(handle);
    };
  }, [intervalMs]);
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
