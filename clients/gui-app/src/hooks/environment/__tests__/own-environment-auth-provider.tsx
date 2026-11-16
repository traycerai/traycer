import type { ReactNode } from "react";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

export function OwnEnvironmentAuthProvider(props: {
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <HostRuntimeContext.Provider value={props.binding}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}
