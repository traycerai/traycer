import {
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import type { WindowsBridgeContextValue } from "@/providers/windows-bridge-context";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { appLogger } from "@/lib/logger";
import {
  applyEpicCanvasDesktopProjection,
  setEpicCanvasDesktopProjectionBridge,
} from "@/stores/epics/canvas/store";
import {
  applyLandingDraftDesktopProjection,
  setLandingDraftDesktopProjectionBridge,
} from "@/stores/home/landing-draft-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  createDebouncedDesktopPerWindowProjectionBridge,
  DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  setActiveDesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import {
  clearDesktopTabsPersistence,
  commitAppliedDesktopTabsSnapshot,
  configureBrowserTabsPersistence,
  configureDesktopTabsAuthority,
  drainDesktopTabsPersistence,
  hydrateDesktopTabs,
  installDesktopTabsPersistence,
  isDesktopTabsCapabilitySupported,
  shouldApplyDesktopTabsSnapshot,
} from "@/stores/tabs/desktop-tabs-persistence";
import { readPersistedCurrentRoute } from "@/lib/persistent-history";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import type {
  DesktopPerWindowSnapshot,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

// One app_opened per renderer at hydration. Secondary windows count too;
// restored_tabs plus PostHog sessions keep launch analyses honest.
let appOpenedTracked = false;

function trackAppOpenedOnce(restoredTabs: boolean): void {
  if (appOpenedTracked) return;
  appOpenedTracked = true;
  Analytics.getInstance().track(AnalyticsEvent.AppOpened, {
    source: restoredTabs ? "restored_session" : "direct_ui",
    launch_reason: "normal",
    restored_tabs: restoredTabs,
  });
}

interface WindowsBridgeProviderProps {
  readonly children: ReactNode;
}

interface WindowsBridgeHydrationRequest {
  readonly bridge: DesktopWindowsBridge;
}

interface DesktopTabsVerification {
  readonly supported: boolean;
  readonly acknowledgedRevision: number | null;
}

interface DesktopSnapshotObservation {
  latest: DesktopPerWindowSnapshot | null;
}

// Hand the tab-sync coordinator a one-shot hydration promise before it
// subscribes, or the snapshot's async arrival scrambles strip order.
let resolveHydrationPromise: (() => void) | null = null;
const hydrationPromise = new Promise<void>((resolve) => {
  resolveHydrationPromise = resolve;
});
installTabSyncCoordinator({ readyPromise: hydrationPromise });

let completedHydrationRequest: WindowsBridgeHydrationRequest | null = null;
const hydrationSubscribers = new Set<() => void>();

function subscribeWindowsBridgeHydration(listener: () => void): () => void {
  hydrationSubscribers.add(listener);
  return () => {
    hydrationSubscribers.delete(listener);
  };
}

function getCompletedHydrationRequest(): WindowsBridgeHydrationRequest | null {
  return completedHydrationRequest;
}

function completeWindowsBridgeHydration(
  request: WindowsBridgeHydrationRequest,
): void {
  if (completedHydrationRequest === request) return;
  completedHydrationRequest = request;
  for (const subscriber of hydrationSubscribers) {
    subscriber();
  }
}

function markHydrated(): void {
  if (resolveHydrationPromise === null) return;
  const resolve = resolveHydrationPromise;
  resolveHydrationPromise = null;
  resolve();
}

/**
 * Desktop windows-bridge projection (tabs, drafts, ownership). Do not read the bearer here; auth authority is `AuthService.getRequestContextProvider()`.
 */
export function WindowsBridgeProvider(
  props: WindowsBridgeProviderProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  const bridge = useMemo(
    () => resolveDesktopWindowsBridge(runnerHost),
    [runnerHost],
  );
  const hydrationRequest = useMemo<WindowsBridgeHydrationRequest | null>(
    () => (bridge === null ? null : { bridge }),
    [bridge],
  );
  const completedRequest = useSyncExternalStore(
    subscribeWindowsBridgeHydration,
    getCompletedHydrationRequest,
    getCompletedHydrationRequest,
  );
  const hasHydrated =
    hydrationRequest === null || completedRequest === hydrationRequest;

  useLayoutEffect(() => {
    if (bridge === null) return installMissingDesktopWindowsBridge();
    if (hydrationRequest === null) return;
    return installDesktopWindowsBridge(bridge, hydrationRequest);
  }, [bridge, hydrationRequest]);

  const value = useMemo<WindowsBridgeContextValue>(
    () => ({ bridge, hasHydrated }),
    [bridge, hasHydrated],
  );
  return (
    <WindowsBridgeContext.Provider value={value}>
      {props.children}
    </WindowsBridgeContext.Provider>
  );
}

function installMissingDesktopWindowsBridge(): () => void {
  clearDesktopWindowsBridge();
  configureBrowserTabsPersistence();
  // Web path has no pagehide flush. Still flush file-edit drafts or a reload
  // within the 100ms debounce loses them.
  const flushFileEditRecovery = (): void => {
    void fileEditRuntimeRegistry.flushRecovery().catch(() => undefined);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushFileEditRecovery);
    window.addEventListener("beforeunload", flushFileEditRecovery);
  }
  queueMicrotask(() => {
    trackAppOpenedOnce(false);
    markHydrated();
  });
  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushFileEditRecovery);
      window.removeEventListener("beforeunload", flushFileEditRecovery);
    }
    clearDesktopWindowsBridge();
  };
}

function installDesktopWindowsBridge(
  bridge: DesktopWindowsBridge,
  hydrationRequest: WindowsBridgeHydrationRequest,
): () => void {
  const lifecycle = { cancelled: false };
  let tabsCompatible = false;
  const projectionBridge = createDebouncedDesktopPerWindowProjectionBridge(
    bridge.perWindowState,
    DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  );
  // Unload cannot await; kick flush so the microtask send leaves.
  // Deliberate quit uses the awaited fresh-snapshot path instead.
  const flushProjection = (): void => {
    void projectionBridge.flush().catch(() => undefined);
    void drainDesktopTabsPersistence().catch(() => undefined);
    void fileEditRuntimeRegistry.flushRecovery().catch(() => undefined);
  };
  setDesktopEpicOwnershipBridge(bridge);
  setActiveDesktopPerWindowProjectionBridge(projectionBridge);
  setEpicCanvasDesktopProjectionBridge(projectionBridge);
  setLandingDraftDesktopProjectionBridge(projectionBridge);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushProjection);
    window.addEventListener("beforeunload", flushProjection);
  }

  const snapshotObservation: DesktopSnapshotObservation = { latest: null };

  const applyNewestSnapshot = (snapshot: DesktopPerWindowSnapshot): void => {
    if (
      snapshotObservation.latest !== null &&
      (snapshot.revision ?? 0) < (snapshotObservation.latest.revision ?? 0)
    ) {
      return;
    }
    snapshotObservation.latest = snapshot;
    applyPerWindowSnapshot(snapshot);
    if (tabsCompatible && shouldApplyDesktopTabsSnapshot(snapshot)) {
      hydrateDesktopTabs(snapshot, true, null);
      commitAppliedDesktopTabsSnapshot(snapshot);
    }
  };

  const perWindowSubscription =
    bridge.perWindowState.onChange(applyNewestSnapshot);

  const isCancelled = (): boolean => lifecycle.cancelled;

  void (async () => {
    if (isCancelled()) return;
    try {
      const snapshot = await bridge.perWindowState.get();
      if (isCancelled()) return;
      applyNewestSnapshot(snapshot);
      const verification = await verifyDesktopTabsCompatibility(
        bridge,
        () => snapshotObservation.latest?.revision ?? 0,
      );
      if (isCancelled()) return;
      tabsCompatible = verification.supported;
      configureDesktopTabsAuthority(tabsCompatible);
      const hydrationSnapshot = snapshotObservation.latest ?? snapshot;
      const hydratedTabs = hydrateDesktopTabs(
        hydrationSnapshot,
        tabsCompatible,
        readPersistedCurrentRoute(bridge.windowId),
      );
      if (tabsCompatible && verification.acknowledgedRevision !== null) {
        installDesktopTabsPersistence(
          bridge,
          Math.max(hydratedTabs.revision, verification.acknowledgedRevision),
        );
      }
      trackAppOpenedOnce(
        hydrationSnapshot.epicTabs.length > 0 ||
          hydrationSnapshot.landingDrafts.length > 0,
      );
    } catch (error) {
      if (isCancelled()) return;
      // Do not leave hydration pending. /draft/new would spin forever.
      appLogger.error(
        "[windows-bridge] per-window snapshot hydration failed",
        {},
        error,
      );
      tabsCompatible = false;
      configureDesktopTabsAuthority(false);
    }
    queueMicrotask(() => {
      if (!lifecycle.cancelled) {
        completeWindowsBridgeHydration(hydrationRequest);
        markHydrated();
      }
    });
  })();

  return () => {
    lifecycle.cancelled = true;
    perWindowSubscription.dispose();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushProjection);
      window.removeEventListener("beforeunload", flushProjection);
    }
    flushProjection();
    projectionBridge.dispose();
    clearDesktopTabsPersistence();
    clearDesktopWindowsBridge();
  };
}

async function verifyDesktopTabsCompatibility(
  bridge: DesktopWindowsBridge,
  minimumRevision: () => number,
): Promise<DesktopTabsVerification> {
  if (typeof bridge.perWindowState.capabilities !== "function") {
    return { supported: false, acknowledgedRevision: null };
  }
  try {
    const capabilities = await bridge.perWindowState.capabilities();
    if (!isDesktopTabsCapabilitySupported(capabilities)) {
      return { supported: false, acknowledgedRevision: null };
    }
    const acknowledgement = await bridge.perWindowState.update({});
    const supported =
      acknowledgement !== undefined &&
      Number.isSafeInteger(acknowledgement.revision) &&
      acknowledgement.revision > minimumRevision() &&
      isDesktopTabsCapabilitySupported(acknowledgement.capabilities);
    return {
      supported,
      acknowledgedRevision: supported ? acknowledgement.revision : null,
    };
  } catch (error) {
    appLogger.warn("[windows-bridge] desktop tab persistence unavailable", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    return { supported: false, acknowledgedRevision: null };
  }
}

function clearDesktopWindowsBridge(): void {
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  setDesktopEpicOwnershipBridge(null);
  setActiveDesktopPerWindowProjectionBridge(null);
}

function applyPerWindowSnapshot(snapshot: DesktopPerWindowSnapshot): void {
  const normalized = normalizePerWindowSnapshot(snapshot);
  applyEpicCanvasDesktopProjection(normalized);
  applyLandingDraftDesktopProjection(normalized);
}

function normalizePerWindowSnapshot(
  snapshot: DesktopPerWindowSnapshot,
): DesktopPerWindowSnapshot {
  const epicTabs = uniquePerWindowTabs(snapshot.epicTabs);
  const landingDrafts = uniqueLandingDrafts(snapshot.landingDrafts);
  if (
    epicTabs.length === snapshot.epicTabs.length &&
    landingDrafts.length === snapshot.landingDrafts.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    epicTabs,
    landingDrafts,
  };
}

function uniquePerWindowTabs(
  tabs: DesktopPerWindowSnapshot["epicTabs"],
): DesktopPerWindowSnapshot["epicTabs"] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    if (seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
}

function uniqueLandingDrafts(
  drafts: DesktopPerWindowSnapshot["landingDrafts"],
): DesktopPerWindowSnapshot["landingDrafts"] {
  const seen = new Set<string>();
  return drafts.flatMap((draft) => {
    if (seen.has(draft.id)) return [];
    seen.add(draft.id);
    return [draft];
  });
}

function resolveDesktopWindowsBridge(
  runnerHost: IRunnerHost,
): DesktopWindowsBridge | null {
  const value: unknown = Reflect.get(runnerHost, "windows");
  return isDesktopWindowsBridge(value) ? value : null;
}

function hasFunctions(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean {
  for (const key of keys) {
    if (typeof value[key] !== "function") return false;
  }
  return true;
}

// requestOpenDraftInNewWindow is optional and probed at the call site.
// Requiring it here would fail the whole bridge on an older preload.
const ROOT_FN_KEYS = [
  "list",
  "onChange",
  "requestNew",
  "requestFocus",
  "requestClose",
  "requestOpenEpicInNewWindow",
] as const;
const OWNERSHIP_FN_KEYS = ["snapshot", "claim", "release", "onChange"] as const;
// clear is optional and probed at the wipe call site. Requiring it here would
// fail the whole bridge on an older preload and fall back to localStorage.
const PER_WINDOW_FN_KEYS = ["get", "update", "onChange"] as const;
const AUTH_FN_KEYS = ["get", "set", "onChange"] as const;

function isDesktopWindowsBridge(value: unknown): value is DesktopWindowsBridge {
  if (!isRecord(value)) return false;
  if (typeof value.windowId !== "string") return false;
  if (!hasFunctions(value, ROOT_FN_KEYS)) return false;
  if (!isRecord(value.ownership) || !isRecord(value.perWindowState)) {
    return false;
  }
  if (!isRecord(value.authSession)) return false;
  return (
    hasFunctions(value.ownership, OWNERSHIP_FN_KEYS) &&
    hasFunctions(value.perWindowState, PER_WINDOW_FN_KEYS) &&
    hasFunctions(value.authSession, AUTH_FN_KEYS)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
