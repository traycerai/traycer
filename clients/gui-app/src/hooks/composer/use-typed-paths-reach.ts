import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import {
  useStagedSandboxStore,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";

/**
 * Whether a path typed into a composer names a file where its agent reads it:
 * `hostId`, the host that agent runs on, is this machine. Decided by host id
 * alone. A machine whose own id is unknown counts as another machine, so its
 * files are attached rather than typed as paths that might name nothing.
 */
export function useTypedPathsReach(hostId: string | null): boolean {
  const localHostId = useReactiveLocalHostId();
  return hostId !== null && hostId === localHostId;
}

/**
 * The same for a composer that can stage a sandbox. While one is staged on
 * `stagedSurfaceKey` its send runs on that sandbox, so a typed path is read
 * there and not on the placement host.
 */
export function useStagedTypedPathsReach(
  stagedSurfaceKey: string | null,
  placementHostId: string | null,
): boolean {
  const stage = useStagedSandboxStore((state) =>
    stagedSurfaceKey === null
      ? null
      : (state.bySurface[stagedSurfaceKey] ?? null),
  );
  return useTypedPathsReach(
    stage === null ? placementHostId : stagedSandboxHostId(stage),
  );
}

/** A new sandbox has no host until the server names it. */
function stagedSandboxHostId(stage: StagedSandbox): string | null {
  return stage.target.kind === "existing"
    ? stage.target.hostId
    : stage.createdHostId;
}
