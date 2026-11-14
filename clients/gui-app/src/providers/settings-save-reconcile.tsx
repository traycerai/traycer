import { useEffect, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";

/** Reconciles one host each time it can be asked again: a connect or a reconnect. */
function HostReconcile(props: {
  readonly hostId: string;
  readonly coordinator: SettingsSaveCoordinator;
}): null {
  const { hostId, coordinator } = props;
  const canExecute = useReactiveHostReadiness(
    useHostClientForHostId(hostId),
  ).canExecute;
  useEffect(() => {
    if (canExecute) void coordinator.reconcile(hostId);
  }, [canExecute, coordinator, hostId]);
  return null;
}

/**
 * Applies this account's remembered saves as their hosts connect. Watches
 * only the hosts a remembered save was made on.
 */
export function SettingsSaveReconcile(props: {
  readonly coordinator: SettingsSaveCoordinator;
}): ReactNode {
  const hostIds = useSettingsSaveMemoryStore(
    useShallow((state) =>
      [
        ...new Set(Object.values(state.records).map((record) => record.hostId)),
      ].toSorted(),
    ),
  );
  return hostIds.map((hostId) => (
    <HostReconcile
      key={hostId}
      hostId={hostId}
      coordinator={props.coordinator}
    />
  ));
}
