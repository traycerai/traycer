import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useResourceMonitorStore } from "@/stores/resources/resource-monitor-store";

/**
 * Which host the header's resource monitor is READING — the same host model
 * Settings administers through, over this surface's own persisted pick.
 *
 * Resolved at the header rather than inside `PopoverContent` because the
 * `resources.subscribe` stream this surface owns is mounted next to the
 * trigger, not inside the panel: the stream has to follow the pick whether or
 * not the panel happens to be open, or reopening would always start cold.
 *
 * The queries behind it (`useHostDirectoryList`, `useRegisteredHosts`) are the
 * shared, already-cached ones every other host surface reads, so the header
 * joins their subscribers rather than opening a second source of host truth.
 */
export interface ResourceMonitorHostScope {
  readonly scope: HostScope;
  /**
   * A host was EXPLICITLY picked, as opposed to following the active one.
   *
   * This is the difference between "I cannot show you the machine you chose"
   * and "the machine this window runs on is having a moment", and only the
   * first is worth replacing the panel with a notice. `HostScope` alone cannot
   * answer it: `unreachable` and `connecting` look identical whether they came
   * from a pick or from the active host.
   */
  readonly hasExplicitPick: boolean;
}

export function useResourceMonitorHostScope(): ResourceMonitorHostScope {
  const scopedHostId = useResourceMonitorStore((state) => state.scopedHostId);
  const setScopedHostId = useResourceMonitorStore(
    (state) => state.setScopedHostId,
  );
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  return { scope, hasExplicitPick: scopedHostId !== null };
}
