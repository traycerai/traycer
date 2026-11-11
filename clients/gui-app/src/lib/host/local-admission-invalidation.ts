import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

const listeners = new Set<(hostId: string) => void>();

/** Subscribe a local admission cache without coupling claim to its transport. */
export function onAppLocalAdmissionInvalidated(
  listener: (hostId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A confirmed claim changes the owner while keeping the same host id. */
export async function invalidateLocalTeamAdmissionAfterClaim(
  hostId: string,
  runnerHost: IRunnerHost,
): Promise<void> {
  for (const listener of Array.from(listeners)) {
    try {
      listener(hostId);
    } catch {
      // A stale consumer must not turn a confirmed claim into a failure.
    }
  }
  try {
    await runnerHost.hostManagement?.invalidateLocalTeamAdmission?.(hostId);
  } catch {
    // The shell may be disconnected. A refused grant OPEN also invalidates
    // its admission cache when the local transport next connects.
  }
}
