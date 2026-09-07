import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useResourceMonitorStore } from "@/stores/resources/resource-monitor-store";

/**
 * Host the header resource monitor reads. Resolved at the header because `resources.subscribe` sits next to the trigger, not inside the panel.
 */
export interface ResourceMonitorHostScope {
  readonly scope: HostScope;
  /** This is the difference between "I cannot show you the machine you chose" and "the machine this window runs on is having a moment", and only the first is worth replacing the panel with a notice. */
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
