import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/** Relay-only shells fall back to the bound host, gated on IRunnerHost.hasLocalHost, not a momentarily null local entry. */
export function useNotificationsServingHostEntry(): HostDirectoryEntry | null {
  const localEntry = useReactiveLocalHostEntry();
  const runnerHost = useRunnerHostOrNull();
  const boundHostId = useAddressableHostId();
  // Same directory every other consumer binds. Empty-id lookup while a local entry exists keeps the fallback snapshot null so a local shell cannot rebind over a discarded row.
  const boundEntry = useHostDirectoryEntry(
    localEntry === null ? (boundHostId ?? "") : "",
  );
  if (localEntry !== null) return localEntry;
  // An undeclared shell (no `RunnerHostProvider` in the tree) is treated as
  // local-capable, so a harness that never states which shell it is cannot
  // silently acquire the fallback.
  if (runnerHost === null || runnerHost.hasLocalHost) return null;
  return boundEntry;
}
