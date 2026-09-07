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
  /** The stored pin - this surface's PREFERRED host. */
  readonly selection: SurfaceHostSelection;
  /** Anything resolving a CLIENT must read this rather than `selection`, or it addresses the dead host while the chip shows the live one - the chip/client divergence the placement layer exists to prevent. */
  readonly honoredSelection: SurfaceHostSelection;
  readonly setSelection: (selection: SurfaceHostSelection) => void;
  /** ALWAYS what the surface's chip renders - a create surface must never be silent about which machine it is about to create on. */
  readonly resolvedHostId: string | null;
  /**
   * Where clearing the pin would resolve (default tier or `effective`). Computed here so Epic-session surfaces do not re-derive app-wide host themselves.
   */
  readonly followingHostId: string | null;
  readonly isPinned: boolean;
  readonly latchOnFirstUse: () => void;
}

/** Which tier answered {@link SurfaceHostPin.resolvedHostId} for a pin that carries a default (see {@link useSurfaceHostPinWithDefault}): the pin, the default, or `effective`. */
export type SurfaceHostPinTier = "pin" | "default" | "effective";

export interface SurfaceHostPinWithDefault extends SurfaceHostPin {
  readonly resolvedFrom: SurfaceHostPinTier;
}

/**
 * A dead pin auto-follows `effective` and returns when the lease is usable again. The pin survives; only the resolution moves.
 */
export function useSurfaceHostPin(surfaceKey: string): SurfaceHostPin {
  return useSurfaceHostPinResolved(surfaceKey, null);
}

/**
 * Unpinned (or deposed pin) resolves `defaultHostId` while that host can serve, else `effective`. Only the `effective` tier follows a move of the effective host.
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
  // That question is only answerable while both are the same expression, so they must not be able to drift.
  // ONE local, deliberately: `resolvedHostId` falls back to this exact value, and consumers compare the two to ask "would unpinning move me?" (`resolvedHostId !== followingHostId`).
  const followingHostId = honoredDefaultHostId ?? effectiveHostId;
  const resolvedHostId = resolvedSurfaceHostId(
    selection,
    followingHostId,
    fleet,
  );
  const resolvedFrom = resolvedTier(honoredSelection, honoredDefaultHostId);

  // Deregistration clears the pin; death never does.
  // Runs as an effect rather than at an app-wide mount so this stays out of the composition root - a pin whose surface is unmounted is pruned the next time it mounts, and the resolver's own absence arm means it is never SERVED in the meantime.
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
