import { createContext } from "react";
import {
  DEFAULT_MAX_LIVE_EPICS,
  OpenEpicSessionRegistry,
} from "@/stores/epics/open-epic/session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { releaseDesktopEpicOwnershipForEpic } from "@/lib/windows/desktop-epic-ownership";

export const EpicSessionContext = createContext<OpenEpicStoreHandle | null>(
  null,
);

export const handleHostIds = new WeakMap<OpenEpicStoreHandle, string | null>();

/**
 * Registry is module-scoped so background Epic tabs survive route transitions
 * - a tab that is navigated away from but kept open in the tab strip stays
 * live (within the MRU cap) so re-entering the route is instant.
 */
export const registry = new OpenEpicSessionRegistry({
  maxLive: DEFAULT_MAX_LIVE_EPICS,
});
registry.setReleaseListener((epicId) => {
  void releaseDesktopEpicOwnershipForEpic(epicId);
});

/**
 * Test / production seam. Defaults to real `EpicStreamClient`; tests swap
 * via `__setEpicStreamClientFactoryForTests(...)` so the provider can be
 * mounted in jsdom without a live host.
 */
let streamClientFactoryOverride: EpicStreamClientFactory | null = null;

export function __setEpicStreamClientFactoryForTests(
  factory: EpicStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getEpicStreamClientFactoryOverride(): EpicStreamClientFactory | null {
  return streamClientFactoryOverride;
}

export function __getOpenEpicRegistryForTests(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * Accessor for the module-scoped live-Epic registry. T8 (desktop
 * app-quit intercept) subscribes to this so it can read the aggregated
 * unsynced-edits map without reaching into provider-local state.
 */
export function getOpenEpicRegistry(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * True when the Epic session for `epicId` currently has unsynced edits
 * that the host has not yet proven coverage for. Called synchronously
 * from the tab-close handler to decide whether to pop the discard-
 * confirmation dialog.
 */
export function epicHasUnsyncedEdits(epicId: string): boolean {
  const handle = registry.get(epicId);
  if (handle === null) return false;
  return handle.store.getState().isDirty;
}

/**
 * Release (forcibly dispose) the Epic session for `epicId`. Called when the
 * user closes a tab in the strip.
 */
export function releaseOpenEpicSession(epicId: string): void {
  registry.release(epicId);
}

export function releaseOpenEpicSessionIfUnused(epicId: string): void {
  const state = useEpicCanvasStore.getState();
  const stillOpen = state.openTabOrder.some(
    (tabId) => state.tabsById[tabId]?.epicId === epicId,
  );
  if (stillOpen) return;
  releaseOpenEpicSession(epicId);
}

/**
 * Forcibly dispose every live Epic session. Wired into the auth lifecycle so
 * sign-out, user-switch, or token expiry cannot leave a prior identity's
 * Y.Doc / queue / focus state behind in the registry - the next sign-in
 * starts fresh from a host snapshot.
 */
export function disposeAllOpenEpicSessions(): void {
  registry.disposeAll();
}
