import { createContext, use } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { MutationProgress } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusSnapshot } from "@/lib/host/compatibility-state";
import type { AuthStatus } from "@/stores/auth/auth-store";

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
  readonly progress: MutationProgress | null;
  /**
   * Last boot-progress event of the current provisioning attempt, non-null
   * only once that attempt has FAILED (when `progress` above has already
   * nulled out). The PROVISIONING-ERROR report reads it so a settled install
   * failure can still say where it died; live surfaces keep reading
   * `progress`.
   *
   * It is cleared only by a new attempt or a successful settle, so it can
   * outlive the surface that owned it - a host that failed to install and
   * then came up by some other route leaves it set. Consumers must therefore
   * scope it to the failure it explains rather than treating it as ambient
   * host state (see `includeRetainedProgress` in the readiness controller);
   * the provisioning-error card is safe because it renders only while that
   * attempt's error is still live.
   */
  readonly lastProgress: MutationProgress | null;
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
    /**
     * `compatible` held from an earlier probe whose latest refetch failed. The
     * surface stays open - the host answered this handshake already - and the
     * degraded connection is surfaced as a banner instead.
     */
    readonly degraded: boolean;
    /**
     * `failed` because the probe never reached the host, rather than because
     * the host rejected the handshake. Drives connection-shaped copy: calling
     * an unreachable host "incompatible" is what made an offline host
     * (traycer#858) and a load-stalled host (traycer#860) both read as version
     * problems.
     */
    readonly unreachable: boolean;
    /**
     * What the host's last `host.status` answer said about itself. Only a
     * `compatible` verdict has an answer to hold; the other states never
     * heard one, so this is null there. Carried for the pre-filled report's
     * health line - a busy host serving turns (traycer#860) must not read
     * like a host that never started.
     */
    readonly hostStatus: HostStatusSnapshot | null;
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
  lastProgress: null,
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
    degraded: false,
    unreachable: false,
    hostStatus: null,
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
  readonly authStatus: AuthStatus;
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
    // Compatibility alone decides here. `hostBusy` deliberately does NOT gate
    // readiness: a busy host is still dialable, and busy is surfaced as the
    // Refresh / Force-update actions by the presentation layer rather than by
    // holding the surface closed. It used to appear as a `hostBusy ||` disjunct
    // in front of this call, which read as a gate but was inert -
    // `readinessForCompatibility` returns READY for `compatible`, so the busy
    // branch and the fall-through produced the same answer.
    return readinessForCompatibility(args.presentation);
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
