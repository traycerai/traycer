import { createContext, use } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostProgressEvent } from "@traycer-clients/shared/platform/runner-host";

export type HostReadinessScope = "none" | "default-host" | "tab-host";

export type SurfaceReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "restoring-request-context" }
  | { readonly kind: "loading-host" }
  | { readonly kind: "mobile-no-host" }
  | { readonly kind: "unavailable-host" }
  | { readonly kind: "provisioning-host" }
  | { readonly kind: "provisioning-error" }
  | { readonly kind: "removed-host" }
  | { readonly kind: "compatibility-checking" }
  | { readonly kind: "compatibility-error" }
  | { readonly kind: "incompatible-host" };

export interface DefaultHostReadinessPresentation {
  readonly localTarget: boolean;
  readonly localHostState: "unknown" | "ready" | "unavailable";
  readonly stage: "loading" | "slow";
  readonly progress: HostProgressEvent | null;
  readonly provisioningError: Error | null;
  readonly provisioning: boolean;
  readonly removed: boolean;
  readonly hostBusy: boolean;
  readonly canManageHost: boolean;
  readonly retryProvisioning: () => void;
  readonly forceProvisioning: () => void;
  readonly reinstall: () => void;
  readonly configureShell: () => void;
  // Owned once by the readiness controller, not per slot: two default-host
  // members in a split must share one respawn mutation so a single click issues
  // exactly one request and locks the action in every slot.
  readonly requestRespawn: () => void;
  readonly respawnPending: boolean;
  readonly compatibility: {
    readonly status: "checking" | "compatible" | "failed" | "incompatible";
    readonly errorMessage: string | null;
    readonly retrying: boolean;
    readonly retry: () => void;
  };
}

export interface HostReadinessController {
  readonly readinessFor: (
    scope: HostReadinessScope,
    tabHostId: string | null,
  ) => SurfaceReadiness;
  readonly defaultHostPresentation: DefaultHostReadinessPresentation;
}

const READY: SurfaceReadiness = { kind: "ready" };

const EMPTY_DEFAULT_HOST_PRESENTATION: DefaultHostReadinessPresentation = {
  localTarget: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
  },
};

export const HostReadinessControllerContext =
  createContext<HostReadinessController>({
    readinessFor: () => READY,
    defaultHostPresentation: EMPTY_DEFAULT_HOST_PRESENTATION,
  });

export function useHostReadinessController(): HostReadinessController {
  return use(HostReadinessControllerContext);
}

export function useSurfaceReadiness(
  scope: HostReadinessScope,
  tabHostId: string | null,
): SurfaceReadiness {
  return useHostReadinessController().readinessFor(scope, tabHostId);
}

export function isHostDialable(entry: HostDirectoryEntry | undefined): boolean {
  return (
    entry !== undefined &&
    entry.status === "available" &&
    entry.websocketUrl !== null
  );
}

export function resolveSurfaceReadiness(args: {
  readonly scope: HostReadinessScope;
  readonly tabHostId: string | null;
  readonly authStatus: string;
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
}): SurfaceReadiness {
  if (args.scope === "none") return READY;
  if (args.authStatus === "signed-in" && args.requestContextUserId === null) {
    return { kind: "restoring-request-context" };
  }
  if (args.scope === "default-host") {
    const activeEntry = args.directoryEntries.find(
      (candidate) => candidate.hostId === args.activeHostId,
    );
    if (
      args.activeHostId !== null &&
      args.requestContextUserId !== null &&
      isHostDialable(activeEntry)
    ) {
      return READY;
    }
    if (!args.hasLocalHost && args.hasMobileNoHost) {
      return { kind: "mobile-no-host" };
    }
    return args.activeHostId === null
      ? { kind: "loading-host" }
      : { kind: "unavailable-host" };
  }
  if (args.tabHostId === null) return { kind: "unavailable-host" };
  const entry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.tabHostId,
  );
  if (!isHostDialable(entry)) return { kind: "unavailable-host" };
  return args.requestContextUserId === null
    ? { kind: "restoring-request-context" }
    : READY;
}

export function projectDefaultHostReadiness(args: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): SurfaceReadiness {
  // `LocalHostGate` intentionally passes remote selections through. Its
  // compatibility and ensure actions manage the bundled local host, so
  // projecting those lifecycle states for a remote target would both block a
  // dialable remote host and offer an action against the wrong machine.
  if (!args.presentation.localTarget) return args.readiness;

  // An in-flight ensure settles independently from transport readiness. It
  // therefore takes precedence over a transient dialable endpoint, exactly as
  // the pre-consolidation gate did: children and stream bridges wait until the
  // ensure result can classify busy/removed/error.
  if (args.presentation.provisioning) return { kind: "provisioning-host" };
  if (args.presentation.removed) return { kind: "removed-host" };

  if (args.readiness.kind === "ready") {
    if (
      args.presentation.hostBusy ||
      args.presentation.compatibility.status !== "compatible"
    ) {
      return readinessForCompatibility(args.presentation);
    }
    return READY;
  }
  if (
    args.readiness.kind !== "loading-host" &&
    args.readiness.kind !== "unavailable-host"
  ) {
    return args.readiness;
  }
  if (args.presentation.provisioningError !== null) {
    return { kind: "provisioning-error" };
  }
  if (
    args.readiness.kind === "loading-host" &&
    args.presentation.localHostState === "unavailable" &&
    args.presentation.stage === "slow"
  ) {
    return { kind: "unavailable-host" };
  }
  return args.readiness;
}

function readinessForCompatibility(
  presentation: DefaultHostReadinessPresentation,
): SurfaceReadiness {
  switch (presentation.compatibility.status) {
    case "checking":
      return { kind: "compatibility-checking" };
    case "compatible":
      return READY;
    case "failed":
      return { kind: "compatibility-error" };
    case "incompatible":
      return { kind: "incompatible-host" };
  }
}
