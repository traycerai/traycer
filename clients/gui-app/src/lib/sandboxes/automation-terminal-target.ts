import type {
  SandboxAutomationOpenTarget,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";

/** Personal uses no body; a team opens its existing pod by ordinal when known. */
export function automationTerminalTarget(
  sandboxId: string | null,
  teamEnvironmentId: string | null,
  pods: readonly SandboxPod[],
): SandboxAutomationOpenTarget | null {
  if (teamEnvironmentId === null) return null;
  const pod = pods.find((candidate) => candidate.sandbox.id === sandboxId);
  return { environmentId: teamEnvironmentId, ordinal: pod?.ordinal ?? null };
}
