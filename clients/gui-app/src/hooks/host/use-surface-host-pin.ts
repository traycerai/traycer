import { useCallback, useEffect, useMemo } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import {
  gitDiffPanelSurfaceKey,
  isSurfacePinDeposed,
  isSurfacePinFleetKnown,
  resolvedSurfaceHostId,
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
  type SurfaceHostSelection,
  type SurfaceKind,
  type SurfacePinFleetView,
} from "@/stores/host/surface-host-selection-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface SurfaceHostPin {
  /**
   * The stored pin - this surface's PREFERRED host. Survives that host's
   * death, which is what makes the return sticky. Write it from the picker;
   * read {@link SurfaceHostPin.honoredSelection} to act on it.
   */
  readonly selection: SurfaceHostSelection;
  /**
   * The pin currently IN FORCE: `selection` while its host can serve, `null`
   * while it cannot. The exact `preferred` → `target` relationship the
   * app-wide authority has, one tier down.
   *
   * Anything resolving a CLIENT must read this rather than `selection`, or it
   * addresses the dead host while the chip shows the live one - the
   * chip/client divergence the placement layer exists to prevent.
   */
  readonly honoredSelection: SurfaceHostSelection;
  readonly setSelection: (selection: SurfaceHostSelection) => void;
  /**
   * Where this surface acts: the pin while it can serve, `effective` while it
   * cannot. ALWAYS what the surface's chip renders - a create surface must
   * never be silent about which machine it is about to create on.
   */
  readonly resolvedHostId: string | null;
  /**
   * Where this surface would resolve with NO pin - its default tier if it has
   * one, else `effective`. In other words, what clearing the pin would move it
   * to.
   *
   * It is here rather than read at the call site because the app-wide host
   * reads are fenced out of Epic-session surfaces by lint, and correctly so: a
   * panel that re-derived `effective` itself would be a second decider on the
   * question this hook already answers. A surface offering "return to
   * following" needs to know whether that would MOVE anything - a remedy that
   * resolves to the same machine is a button that cannot work - and this is
   * that answer, computed on the same three tiers `resolvedHostId` is.
   */
  readonly followingHostId: string | null;
  readonly isPinned: boolean;
  readonly latchOnFirstUse: () => void;
}

/**
 * Which tier answered {@link SurfaceHostPin.resolvedHostId} for a pin that
 * carries a default (see {@link useSurfaceHostPinWithDefault}): the pin, the
 * default, or `effective`. A surface reads this to know whether a move of the
 * effective host re-points it - only the `effective` tier follows one.
 */
export type SurfaceHostPinTier = "pin" | "default" | "effective";

export interface SurfaceHostPinWithDefault extends SurfaceHostPin {
  readonly resolvedFrom: SurfaceHostPinTier;
}

/**
 * This surface's host pin, resolved.
 *
 * A pinned surface whose host dies AUTO-FOLLOWS to `effective` and returns to
 * its pin when the host's lease is usable again - the same shape, one tier
 * down, as the app-wide preferred/effective pair, and deliberately as silent
 * as the app-wide failover is. The pin survives the death; only the resolution
 * moves. See {@link resolvedSurfaceHostId} for why the death test is what it
 * is.
 */
export function useSurfaceHostPin(surfaceKey: string): SurfaceHostPin {
  return useSurfaceHostPinResolved(surfaceKey, null);
}

/**
 * The same pin with a DEFAULT tier between it and `effective`: unpinned, or
 * pinned to a host that cannot serve, the surface resolves `defaultHostId`
 * while THAT host can serve, and only then `effective`. Death is judged for
 * the default exactly as for the pin ({@link isSurfacePinDeposed}), so the
 * three tiers cannot disagree about what "cannot serve" means, and the
 * default is never written anywhere - it is a fallback the caller derives
 * (the in-Epic modal passes the Epic session's host), not a second pin.
 *
 * `resolvedFrom` names the tier that answered. Only the `effective` tier
 * follows a move of the effective host; a surface on its pin or its default
 * is not re-pointed by one and must not narrate one.
 */
export function useSurfaceHostPinWithDefault(
  surfaceKey: string,
  defaultHostId: string | null,
): SurfaceHostPinWithDefault {
  return useSurfaceHostPinResolved(surfaceKey, defaultHostId);
}

function resolvedTier(
  honoredSelection: SurfaceHostSelection,
  honoredDefaultHostId: string | null,
): SurfaceHostPinTier {
  if (honoredSelection !== null) return "pin";
  if (honoredDefaultHostId !== null) return "default";
  return "effective";
}

function useSurfaceHostPinResolved(
  surfaceKey: string,
  defaultHostId: string | null,
): SurfaceHostPinWithDefault {
  const stored = useSurfaceHostSelectionStore(
    (state) => state.selections[surfaceKey],
  );
  const selection: SurfaceHostSelection = stored ?? null;
  const setSelectionRaw = useSurfaceHostSelectionStore(
    (state) => state.setSelection,
  );
  const latchRaw = useSurfaceHostSelectionStore(
    (state) => state.latchOnFirstUse,
  );
  const clearPinsForHost = useSurfaceHostSelectionStore(
    (state) => state.clearPinsForHost,
  );
  const effectiveHostId = useEffectiveHostId();
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  const fleet = useMemo<SurfacePinFleetView>(
    () => ({ authorityAttached, leases }),
    [authorityAttached, leases],
  );
  const honoredSelection: SurfaceHostSelection =
    selection !== null && isSurfacePinDeposed(selection, fleet)
      ? null
      : selection;
  // The default tier is honored on the pin's own rule, so "cannot serve"
  // means one thing across all three tiers.
  const honoredDefaultHostId =
    defaultHostId !== null && !isSurfacePinDeposed(defaultHostId, fleet)
      ? defaultHostId
      : null;
  // ONE local, deliberately: `resolvedHostId` falls back to this exact value,
  // and consumers compare the two to ask "would unpinning move me?"
  // (`resolvedHostId !== followingHostId`). That question is only answerable
  // while both are the same expression, so they must not be able to drift.
  const followingHostId = honoredDefaultHostId ?? effectiveHostId;
  const resolvedHostId = resolvedSurfaceHostId(
    selection,
    followingHostId,
    fleet,
  );
  const resolvedFrom = resolvedTier(honoredSelection, honoredDefaultHostId);

  // Deregistration clears the pin; death never does. Runs as an effect rather
  // than at an app-wide mount so this stays out of the composition root - a
  // pin whose surface is unmounted is pruned the next time it mounts, and the
  // resolver's own absence arm means it is never SERVED in the meantime.
  useEffect(() => {
    if (selection === null) return;
    if (!isSurfacePinFleetKnown(fleet)) return;
    if (fleet.leases.some((lease) => lease.hostId === selection)) return;
    clearPinsForHost(selection);
  }, [clearPinsForHost, fleet, selection]);

  const setSelection = useCallback(
    (next: SurfaceHostSelection) => {
      setSelectionRaw(surfaceKey, next);
    },
    [setSelectionRaw, surfaceKey],
  );
  const latchOnFirstUse = useCallback(() => {
    if (resolvedHostId === null) return;
    latchRaw(surfaceKey, resolvedHostId);
  }, [latchRaw, resolvedHostId, surfaceKey]);
  return {
    selection,
    honoredSelection,
    setSelection,
    resolvedHostId,
    followingHostId,
    isPinned: selection !== null,
    latchOnFirstUse,
    resolvedFrom,
  };
}

export function useSurfaceHostClient(
  resolvedHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  return useHostClientForHostId(resolvedHostId);
}

export function useTabSurfaceKey(
  kind: Extract<SurfaceKind, "file-tree" | "new-terminal" | "browsers">,
  tabId: string,
): string {
  return tabSurfaceKey(kind, tabId);
}

export function useGitDiffPanelSurfaceKey(tileRef: string): string {
  return gitDiffPanelSurfaceKey(tileRef);
}
