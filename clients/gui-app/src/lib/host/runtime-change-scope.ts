import type { HostClientChangeEvent } from "@traycer-clients/shared/host-client/host-client";

/** WHICH `HostClient` change events tear down the runtime messenger's binding. */
export function buildRuntimeChangeScopeHandler(deps: {
  /** `RuntimeHostMessengerBinding.reset` - no-op when no runtime messenger. */
  readonly resetMessenger: () => void;
  /** The retired-context session sweep. */
  readonly sweepRetiredSessions: () => void;
}): (event: HostClientChangeEvent) => void {
  return (event) => {
    if (event.reason !== "auth-changed") {
      return;
    }
    deps.resetMessenger();
    deps.sweepRetiredSessions();
  };
}
