import type {
  SandboxAutomationOpenTarget,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";

/** A named team pod waits for its ordinal; only an unstarted team picks any pod. */
export function automationTerminalTarget(
  sandboxId: string | null,
  teamEnvironmentId: string | null,
  pods: readonly SandboxPod[],
): SandboxAutomationOpenTarget | null | undefined {
  if (teamEnvironmentId === null) return null;
  if (sandboxId === null)
    return { environmentId: teamEnvironmentId, ordinal: null };
  const pod = pods.find((candidate) => candidate.sandbox.id === sandboxId);
  return pod === undefined
    ? undefined
    : { environmentId: teamEnvironmentId, ordinal: pod.ordinal };
}
