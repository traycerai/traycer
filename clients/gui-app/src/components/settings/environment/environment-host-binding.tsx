import type { ReactNode } from "react";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Re-provides the host binding of an Environment region that reads the ambient
 * binding directly (the Agents page's Definitions tab, Permissions' Browser
 * agent access) to the host the Environment dropdown names: a Local row's computer, else the window's own.
 *
 * Rendered unconditionally, so a pick resolving does not change the element
 * type here and remount the page. The ambient binding stands in only for the
 * window's own host: a Local row naming another computer that cannot be used
 * yet shows the host gate instead of the region, which would otherwise read and
 * write this window's host under that computer's name. A Settings page holds
 * no composer, so no microphone path runs beneath it (see
 * `use-scoped-host-binding`).
 */
export function EnvironmentHostBinding(props: {
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  const scope = usePersonalHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const awaitingLocalHost =
    pick.kind === "local" &&
    pick.hostId !== scope.activeHostId &&
    scopedBinding === null;
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      {awaitingLocalHost ? (
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          {null}
        </HostScopeGate>
      ) : (
        props.children
      )}
    </HostRuntimeContext.Provider>
  );
}
