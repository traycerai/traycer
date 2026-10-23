import type { ReactNode } from "react";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";

/**
 * Re-provides the host binding of an Environment page that reads the ambient
 * binding directly (Agent definitions, Browser agent access) to the host the
 * Environment dropdown names: a Local row's computer, else the window's own.
 *
 * Rendered unconditionally, falling back to the ambient binding, so a pick
 * resolving does not change the element type here and remount the page. A
 * Settings page holds no composer, so no microphone path runs beneath it
 * (see `use-scoped-host-binding`).
 */
export function EnvironmentHostBinding(props: {
  readonly children: ReactNode;
}): ReactNode {
  const scope = usePersonalHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}
