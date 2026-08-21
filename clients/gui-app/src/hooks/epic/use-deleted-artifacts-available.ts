import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

/** Whether a host negotiated the complete deleted-artifact recovery surface. */
export function useDeletedArtifactsAvailable(hostId: string | null): boolean {
  const supportsList = useHostSupportsMethod(
    hostId,
    "epic.deletedArtifacts.list",
  );
  const supportsRevive = useHostSupportsMethod(
    hostId,
    "epic.deletedArtifacts.revive",
  );
  return hostId !== null && supportsList && supportsRevive;
}
