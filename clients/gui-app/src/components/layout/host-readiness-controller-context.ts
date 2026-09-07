import { createContext, use } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { MutationProgress } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusSnapshot } from "@/lib/host/compatibility-state";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
import type { AuthStatus } from "@/stores/auth/auth-store";

export type HostReadinessScope = "none" | "default-host" | "tab-host";

/** An incompatible host is therefore never usable, never a failover candidate, and the window narrator - not
 * this gate - says so. */
export type SurfaceReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "restoring-request-context" }
  | { readonly kind: "loading-host" }
  | { readonly kind: "mobile-no-host" }
  | { readonly kind: "unavailable-host" }
  | { readonly kind: "provisioning-host" }
  | { readonly kind: "provisioning-error" }
  | { readonly kind: "removed-host" };

/** `unknown` therefore behaves like `remote` by default: pass readiness through, offer no host-management
 * action for a machine this app cannot manage. */
export type HostTargetKind = "local" | "remote" | "unknown";

export interface DefaultHostReadinessPresentation {
  readonly targetKind: HostTargetKind;
  /** It exists because `targetKind` alone cannot answer that question while the target is `unknown`. */
  readonly localBootIntent: boolean;
  readonly localHostState: "unknown" | "ready" | "unavailable";
  readonly stage: "loading" | "slow";
  readonly progress: MutationProgress | null;
  /** Consumers must therefore scope it to the failure it explains rather than treating it as ambient host state
   * (see `includeRetainedProgress` in the readiness controller). */
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
  /** They are host-management-free on purpose: that state is reached when the derivation had nowhere to go, which
   * includes fleets holding only machines this app cannot manage. */
  readonly refreshDirectory: () => void;
  readonly openSettings: () => void;
  // `requestRespawn`/`respawnPending` sat here too, owned once so two default-host slots in a split shared one
  // respawn lock.
  /** The fields that drove narration - `errorMessage`, `retry`, `retrying` - went with the surfaces that read
   * them; leaving them here would be the retry wiring orphaned rather than deleted. */
  readonly compatibility: {
    readonly status: "checking" | "compatible" | "failed" | "incompatible";
    /** A report says so - "compatible (degraded)" - because triage needs to know the verdict was held rather than
     * freshly answered. */
    readonly degraded: boolean;
    /** `failed` because the probe never reached the host, rather than because the host rejected the handshake. */
    readonly unreachable: boolean;
    /** Carried for the pre-filled report's health line - a busy host serving turns (traycer#860) must not read like
     * a host that never started. */
    readonly hostStatus: HostStatusSnapshot | null;
  };
}

export interface HostReadinessController {
  readonly readinessFor: (
    scope: HostReadinessScope,
    tabHostId: string | null,
  ) => SurfaceReadiness;
  readonly defaultHostPresentation: DefaultHostReadinessPresentation;
  /** It goes `false` -> `true` exactly once per mount and is never set back, so lifting it costs one extra render
   * of this context's consumers per window rather than a repeated global invalidation. */
  readonly hasBeenDefaultHostReady: boolean;
}

/** Exported and shared rather than re-derived per caller, in the image of windowNarratorOwns: one function,
 * several readers. */
export function gateBlocksApp(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): boolean {
  // Only a signed-in user can HAVE a ready default host, so blocking anyone
  // else would hide the sign-in surface behind a host that cannot exist yet.
  if (!args.signedIn) return false;
  // Settings is the escape hatch for a host that cannot start - its Shell page
  // edits the launch config through the CLI with no running host involved.
  if (args.bypassed) return false;
  if (args.readiness.kind === "ready") return false;
  // After the first `ready` render the gate latches and never replaces the app again; `mobile-no-host` is the
  // one kind that keeps its full-screen surface.
  if (args.hasBeenReady && !keepsSplashAfterLatch(args.readiness.kind)) {
    return false;
  }
  return true;
}

/** For a narrator-owned kind the gate still blocks (the app must not mount against a host that cannot serve it)
 * but draws only the frame, leaving the words to the window modal. */
export function gateCardReadiness(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): GateDrawnReadiness | null {
  if (!gateBlocksApp(args)) return null;
  // `GateDrawnReadiness` excludes `ready` and every narrator-owned kind, so answering with the value means the
  // gate's renderer can only ever be handed a kind it is allowed to draw - a compile error otherwise.
  if (args.readiness.kind === "ready") return null;
  if (windowNarratorOwns(args.readiness)) return null;
  return args.readiness;
}

/** A wrapper rather than a second implementation: the window modal suppresses itself exactly when this card is
 * on screen, and both surfaces must be answering the same question with the same code. */
export function gateDrawsOwnCard(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): boolean {
  return gateCardReadiness(args) !== null;
}

const READY: SurfaceReadiness = { kind: "ready" };

const EMPTY_DEFAULT_HOST_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
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
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

export const HostReadinessControllerContext =
  createContext<HostReadinessController>({
    readinessFor: () => READY,
    defaultHostPresentation: EMPTY_DEFAULT_HOST_PRESENTATION,
    hasBeenDefaultHostReady: false,
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

/** `hasReadySession` is supplied by the caller rather than read from the pull-only session cache here. */
export function isHostDialable(
  entry: HostDirectoryEntry | undefined,
  hasReadySession: boolean,
): boolean {
  return (
    entry !== undefined &&
    dialableHostEndpointFor(entry, hasReadySession) !== null
  );
}

/** `null` covers three different situations that must all defer to the weaker evidence rather than terminate
 * the derivation: the kernel has not attached, no lease exists for this host, and the lease says `connecting`. */
function defaultHostLease(args: {
  readonly activeHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): HostLeaseSnapshot | null {
  if (!args.authorityAttached || args.activeHostId === null) return null;
  const lease = args.leases.find(
    (candidate) => candidate.hostId === args.activeHostId,
  );
  if (lease === undefined || lease.status === "connecting") return null;
  return lease;
}

/** The app-wide surface's readiness. */
function defaultHostReadiness(args: {
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly hasReadySessionFor: (hostId: string) => boolean;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): SurfaceReadiness {
  const activeEntry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.activeHostId,
  );
  if (
    args.activeHostId !== null &&
    args.requestContextUserId !== null &&
    isHostDialable(
      activeEntry,
      activeEntry !== undefined && args.hasReadySessionFor(activeEntry.hostId),
    )
  ) {
    return READY;
  }
  if (!args.hasLocalHost && args.hasMobileNoHost) {
    return { kind: "mobile-no-host" };
  }
  // Without it the choice was made by a proxy - "is there an id" - which answers `loading-host` for a host that
  // is definitively gone and `unavailable-host` for one that is merely still connecting.
  const lease = defaultHostLease(args);
  if (lease !== null) {
    return lease.status === "dead"
      ? { kind: "unavailable-host" }
      : { kind: "loading-host" };
  }
  return args.activeHostId === null
    ? { kind: "loading-host" }
    : { kind: "unavailable-host" };
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
  readonly hasReadySessionFor: (hostId: string) => boolean;
  /** The tab-host arm below deliberately does not read them: a tab is bound to its host for life and asks a
   * window-local question - "does a route to my host exist". */
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): SurfaceReadiness {
  if (args.scope === "none") return READY;
  if (args.authStatus === "signed-in" && args.requestContextUserId === null) {
    return { kind: "restoring-request-context" };
  }
  if (args.scope === "default-host") return defaultHostReadiness(args);
  if (args.tabHostId === null) return { kind: "unavailable-host" };
  const entry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.tabHostId,
  );
  if (!isHostDialable(entry, args.hasReadySessionFor(args.tabHostId))) {
    return { kind: "unavailable-host" };
  }
  return args.requestContextUserId === null
    ? { kind: "restoring-request-context" }
    : READY;
}

/** An unresolved remote pick never qualifies, which is the misattribution this whole tri-state exists to close. */
export function presentsLocalHostLifecycle(
  presentation: DefaultHostReadinessPresentation,
): boolean {
  return targetPresentsLocalHostLifecycle(
    presentation.targetKind,
    presentation.localBootIntent,
  );
}

/** The same question asked of the two raw inputs, for callers that are still building the presentation and so
 * have nothing to pass the predicate above. */
export function targetPresentsLocalHostLifecycle(
  targetKind: HostTargetKind,
  localBootIntent: boolean,
): boolean {
  if (targetKind === "local") return true;
  return targetKind === "unknown" && localBootIntent;
}

export function projectDefaultHostReadiness(args: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): SurfaceReadiness {
  // The local-host lifecycle this projects - install, start, respawn.
  if (!presentsLocalHostLifecycle(args.presentation)) return args.readiness;

  // It therefore takes precedence over a transient dialable endpoint, exactly as the pre-consolidation gate did:
  // children and stream bridges wait until the ensure result can classify busy/removed/error.
  if (args.presentation.provisioning) return { kind: "provisioning-host" };
  if (args.presentation.removed) return { kind: "removed-host" };

  // `hostBusy` has never gated readiness either, and still does not: a busy host is dialable, and busy is an
  // action-level fact, not a closed surface.
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

/** Exactly one narrator per scope is the rule, and these three kinds are the ones the global modal now speaks
 * for: a window with no host yet, a window whose host cannot be reached. */
export type WindowNarratedReadiness = Extract<
  SurfaceReadiness,
  {
    readonly kind: "loading-host" | "unavailable-host" | "provisioning-host";
  }
>;

/** The gate's renderers accept only this, so a kind the narrator owns cannot be rendered here even by accident,
 * and the reverse holds too. */
export type GateDrawnReadiness = Exclude<
  SurfaceReadiness,
  WindowNarratedReadiness | { readonly kind: "ready" }
>;

export function windowNarratorOwns(
  readiness: SurfaceReadiness,
): readiness is WindowNarratedReadiness {
  return (
    readiness.kind === "loading-host" ||
    readiness.kind === "unavailable-host" ||
    readiness.kind === "provisioning-host"
  );
}

/** `restoring-request-context` answering `false` here is the same deliberate classification it had before. */
export function keepsSplashAfterLatch(kind: SurfaceReadiness["kind"]): boolean {
  return kind === "mobile-no-host";
}
