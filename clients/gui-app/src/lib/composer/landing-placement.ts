import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Display name for a host the composer is about to talk about. The generic
 * fallbacks are deliberate: the composer names a device in refusal and notice
 * copy, and a raw uuid there reads as a bug. `null` entries = directory not
 * loaded yet.
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

/**
 * Everything the composer knows about where it would place a new epic/chat,
 * captured at the moment of submit.
 */
export interface LandingPlacementTarget {
  /** `pin ?? effective` - the host the composer's chip is rendering. */
  readonly resolvedHostId: string | null;
  /**
   * The client the creates would actually be sent on: the app-wide bound
   * client while following, this pin's own requester while pinned.
   */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  /**
   * A caller-NAMED host that is dead.
   *
   * Only the row-scoped `overrideHostId` path can set this, and the
   * distinction is the whole reason the flag survived the auto-follow ruling.
   * A PIN is a placement preference: when its host dies the composer
   * re-resolves to `effective`, the chip says so, and the create lands there.
   * An OVERRIDE is an instruction naming one machine ("start this here"), and
   * silently landing it somewhere else is the behind-the-back class the
   * ruling was protecting against, not an instance of it.
   */
  readonly namedHostDead: boolean;
}

export type LandingPlacement =
  | {
      readonly kind: "ready";
      readonly hostId: string;
      readonly client: HostClient<HostRpcRegistry>;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Selection model §54's submit-time re-validation, as a pure function.
 *
 * "The composer additionally re-validates at submit time - submit re-validates
 * the resolved host is usable (refuse with an inline error, never create on a
 * silently different host)."
 *
 * The last clause is the load-bearing one, and it is why this returns the
 * CLIENT rather than a boolean: the caller sends on the returned client, whose
 * `getActiveHostId()` was just checked against the chip's host. A create can
 * therefore only land where the chip says, or not at all - a refusal is a
 * refusal, never a fallback onto whichever machine the window happens to be
 * bound to.
 *
 * Both refusable states are real and distinct:
 *  - a host the CALLER NAMED that went offline while the user typed - the
 *    row-scoped modal's `overrideHostId`, where the machine is the request,
 *    so the remedy is naming another one rather than a silent substitution.
 *    A PIN no longer reaches this arm: a pinned surface whose host dies
 *    re-resolves to `effective` before submit is ever reached, and the chip
 *    has been showing that host since the moment it moved;
 *  - a resolved host the transport cannot address yet, which includes the
 *    window's own effective host during a switch (the authority names the new
 *    host before the directory row that makes it dialable arrives).
 */
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
      // Deliberately offers no in-place remedy: this arm is reachable only
      // from a request that NAMED this device, and that surface's picker is
      // inert (§55), so "pick another device" would point at a control the
      // reader cannot use.
      message: `${target.hostLabel} is offline. Start this from another device, or try again once it's back.`,
    };
  }
  if (target.client === null) {
    return {
      kind: "refused",
      message: `${target.hostLabel} can't be reached right now. Pick another device and try again.`,
    };
  }
  // Identity, not liveness: a requester pinned to a host answers with that
  // host's id, and the app-wide client answers with whatever it is bound to.
  // A disagreement here means the composer would create somewhere other than
  // the machine it is showing.
  //
  // Callers that pass `useComposerPlacement().submitTarget` satisfy this by
  // CONSTRUCTION - a frozen requester's id is the resolved id - and that is
  // the point: freezing turns "checked once at submit" into "cannot drift
  // mid-chain". The arm stays because it is what makes this resolver safe for
  // any future caller that hands it a mutable client, and because the ∅-client
  // arm above cannot distinguish "not addressable" from "addresses something
  // else". Do not read a passing check here as proof a chain is frozen.
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
