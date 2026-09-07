import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostRpcRegistry } from "@/lib/host";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";

/**
 * Display name for a host the composer is about to talk about.
 * The generic fallbacks are deliberate: the composer names a device in refusal and notice copy, and a raw uuid there reads as a bug.
 */
export function composerHostLabel(
  entries: ReadonlyArray<HostDirectoryEntry> | null,
  hostId: string | null,
): string {
  if (hostId === null) return "This device";
  const entry = entries?.find((candidate) => candidate.hostId === hostId);
  return entry === undefined || entry.label.length === 0
    ? "The selected device"
    : entry.label;
}

/** Everything the composer knows about where it would place a new epic/chat, captured at the moment of submit. */
export interface LandingPlacementTarget {
  /** `pin ?? effective` - the host the composer's chip is rendering. */
  readonly resolvedHostId: string | null;
  /**
   * The client the creates would actually be sent on: the app-wide bound client while following, this pin's own requester while pinned.
   */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  /** A caller-NAMED host that is dead. */
  readonly namedHostDead: boolean;
}

export type LandingPlacement =
  | {
      readonly kind: "ready";
      readonly hostId: string;
      readonly client: HostClient<HostRpcRegistry>;
    }
  | { readonly kind: "refused"; readonly message: string };

/** Selection model §54's submit-time re-validation, as a pure function. */
export function resolveLandingPlacement(
  target: LandingPlacementTarget,
): LandingPlacement {
  if (target.resolvedHostId === null) {
    return {
      kind: "refused",
      message:
        "No device is available right now. Connect a device before starting a task.",
    };
  }
  if (target.namedHostDead) {
    return {
      kind: "refused",
      // Deliberately offers no in-place remedy: this arm is reachable only from a request that NAMED this device, and that surface's picker is inert (§55), so "pick another device" would point at a control the reader cannot use.
      message: `${target.hostLabel} is offline. Start this from another device, or try again once it's back.`,
    };
  }
  if (target.client === null) {
    return {
      kind: "refused",
      message: `Traycer can't access ${target.hostLabel} for this account right now. Sign in again or pick another device.`,
    };
  }
  const clientWithOptionalActiveHost: {
    readonly getActiveHost?: () => HostDirectoryEntry | null;
  } = target.client;
  const activeHost = clientWithOptionalActiveHost.getActiveHost?.();
  if (activeHost === null) {
    return {
      kind: "refused",
      message: `${target.hostLabel} is starting. Wait for it to come up and send again.`,
    };
  }
  if (
    activeHost !== undefined &&
    dialableHostEndpointFor(
      activeHost,
      hasReadyRemoteSession(activeHost.hostId),
    ) === null
  ) {
    return {
      kind: "refused",
      message: unavailableLandingTargetMessage(activeHost, target.hostLabel),
    };
  }
  // Identity, not liveness: a requester pinned to a host answers with that host's id, and the app-wide client answers with whatever it is bound to.
  // A disagreement here means the composer would create somewhere other than the machine it is showing.
  if (target.client.getActiveHostId() !== target.resolvedHostId) {
    return {
      kind: "refused",
      message: `${target.hostLabel} isn't connected yet. Wait for it to come up and send again.`,
    };
  }
  return {
    kind: "ready",
    hostId: target.resolvedHostId,
    client: target.client,
  };
}

function unavailableLandingTargetMessage(
  activeHost: HostDirectoryEntry,
  hostLabel: string,
): string {
  if (activeHost.websocketUrl === null) {
    return `${hostLabel} is starting. Wait for it to come up and send again.`;
  }
  if (hostUnavailability(activeHost) === "plan-restricted") {
    return `${hostLabel} isn't available on your plan.`;
  }
  return `${hostLabel} is offline. Wait for it to come up and send again.`;
}
