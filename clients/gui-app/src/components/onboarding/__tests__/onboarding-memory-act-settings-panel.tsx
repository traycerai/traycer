import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AgentMemoriesSettingsPanel } from "@/components/settings/panels/agent-memories-settings-panel";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";

/**
 * Settings → Agent memories, as the person opens it after the tour: the real
 * panel, bound to the host a test names, mounted and unmounted on demand.
 */
export function SettingsPanelSlot(props: {
  readonly onMount: (mount: ((hostId: string | null) => void) | null) => void;
}): ReactNode {
  const [mounted, setMounted] = useState<string | null>(null);
  const { onMount } = props;
  useEffect(() => {
    onMount(setMounted);
    return () => onMount(null);
  }, [onMount]);
  return mounted === null ? null : <BoundSettingsPanel hostId={mounted} />;
}

function BoundSettingsPanel(props: { readonly hostId: string }): ReactNode {
  const ambient = useHostBinding();
  const { hostId } = props;
  const binding = useMemo(
    () =>
      ambient === null
        ? null
        : {
            ...ambient,
            hostClient: ambient.hostClient.createRequesterForHostId(hostId),
            hostId,
          },
    [ambient, hostId],
  );
  return (
    <HostRuntimeContext.Provider value={binding}>
      <AgentMemoriesSettingsPanel />
    </HostRuntimeContext.Provider>
  );
}
