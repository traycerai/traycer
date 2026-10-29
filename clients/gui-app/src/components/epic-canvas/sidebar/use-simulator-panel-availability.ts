import { useSimulatorCatalogContext } from "@/components/epic-canvas/renderers/simulator-catalog-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useSimulatorStatusQuery } from "@/hooks/simulator/use-simulator-mutations";

/**
 * The two inputs of the Mobile simulators panel's presence rule: this
 * machine's host can run a simulator platform, or the task's catalog holds a
 * record (a session on any machine, ended ones included until dismissed).
 */
export function useSimulatorPanelAvailability(): {
  readonly localHostRunsSimulators: boolean;
  readonly hasSimulatorRecords: boolean;
} {
  const localHostId = useReactiveLocalHostId();
  const localClient = useHostClientForHostId(localHostId);
  const status = useSimulatorStatusQuery(
    localHostId === null ? null : localClient,
    localHostId,
  );
  const catalog = useSimulatorCatalogContext();
  return {
    localHostRunsSimulators:
      status.data?.platforms.some((platform) => platform.available) === true,
    hasSimulatorRecords:
      catalog?.scope === "cloud" && catalog.records.length > 0,
  };
}
